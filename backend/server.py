import asyncio
import json
from functools import lru_cache
from typing import Optional

import os

from fastapi import FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from langchain_core.tools import tool
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langgraph.prebuilt import create_react_agent
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

LLM_TIMEOUT = 120


# ── Cached client factories ────────────────────────────────────────────────────

@lru_cache(maxsize=256)
def get_openai_clients(token: str, model_id: str):
    from langchain_openai import ChatOpenAI, OpenAIEmbeddings
    embedding = OpenAIEmbeddings(model="text-embedding-3-small", openai_api_key=token)
    llm       = ChatOpenAI(model=model_id, openai_api_key=token, streaming=True)
    return llm, embedding


@lru_cache(maxsize=256)
def get_gemini_clients(token: str, model_id: str):
    from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
    embedding = GoogleGenerativeAIEmbeddings(model="gemini-embedding-001", google_api_key=token)
    llm       = ChatGoogleGenerativeAI(model=model_id, google_api_key=token, streaming=True)
    return llm, embedding


@lru_cache(maxsize=256)
def get_claude_client(token: str, model_id: str):
    from langchain_anthropic import ChatAnthropic
    return ChatAnthropic(model=model_id, anthropic_api_key=token, streaming=True)


# ── Helpers ────────────────────────────────────────────────────────────────────

def get_top_chunks(query: str, chunks: list, embedding=None) -> str:
    if not chunks:
        return ""
    if embedding:
        doc_vectors  = embedding.embed_documents(chunks)
        query_vector = embedding.embed_query(query)
        scores = cosine_similarity([query_vector], doc_vectors)[0]
    else:
        vectorizer = TfidfVectorizer()
        matrix     = vectorizer.fit_transform(chunks + [query])
        scores     = cosine_similarity(matrix[-1], matrix[:-1])[0]
    top_indices = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)[:3]
    return "\n\n".join(chunks[i] for i, _ in top_indices)


def _resolve_llm(provider: str, token: str, model: Optional[str], gemini_key: Optional[str] = None):
    if provider == "openai":
        model_id = model or "gpt-4.1-mini"
        return get_openai_clients(token, model_id)
    if provider == "gemini":
        model_id = model or "gemini-2.5-flash"
        return get_gemini_clients(token, model_id)
    if provider == "claude":
        model_id = model or "claude-haiku-4-5"
        llm = get_claude_client(token, model_id)
        if gemini_key:
            from langchain_google_genai import GoogleGenerativeAIEmbeddings
            embedding = GoogleGenerativeAIEmbeddings(model="gemini-embedding-001", google_api_key=gemini_key)
            return llm, embedding
        return llm, None
    raise ValueError(f"Unsupported provider: {provider}")


def _sse_error_handler(e: Exception, provider: str) -> str:
    msg = str(e).lower()
    if any(k in msg for k in ("api key", "apikey", "authentication", "unauthorized", "invalid")):
        return f"Invalid API key for {provider}. Check your key in Settings."
    return f"Stream error ({provider}): {e}"


# ── /chat endpoint ────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    query:      str
    text:       str                  = ""
    model:      Optional[str]        = None
    history:    Optional[list[dict]] = None
    gemini_key: Optional[str]        = None
    tool_keys:  Optional[dict]       = None


@app.post("/chat")
async def chat(
    body: ChatRequest,
    token:    str = Header(..., alias="Token"),
    provider: str = Header(..., alias="Provider"),
):
    from langchain_core.messages import HumanMessage, AIMessage, SystemMessage

    token    = token.strip()
    provider = provider.lower()

    if not token:
        raise HTTPException(status_code=400, detail="No API key provided. Open Settings and add your key.")

    try:
        llm, embedding = _resolve_llm(provider, token, body.model, body.gemini_key)
    except Exception as e:
        msg = str(e).lower()
        if any(k in msg for k in ("api key", "apikey", "authentication", "unauthorized", "invalid")):
            raise HTTPException(status_code=401, detail=f"Invalid API key for {provider}. Check your key in Settings.")
        raise HTTPException(status_code=500, detail=f"Server error ({provider}): {e}")

    # ── Chunk the page text ───────────────────────────────────────────────────
    chunks = []
    if body.text.strip():
        splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
        chunks = splitter.split_text(body.text)

    # ── Define the search_page tool ───────────────────────────────────────────
    @tool
    def search_page(query: str) -> str:
        """Search the current webpage for content relevant to the query.
        Use this when the user asks about something on the page they are viewing."""
        if not chunks:
            return "No page content available."
        try:
            return get_top_chunks(query, chunks, embedding)
        except Exception:
            return get_top_chunks(query, chunks, None)

    # ── Define the summarize_page tool ──────────────────────────────────────────
    @tool
    def summarize_page() -> str:
        """Return the full page text for summarization.
        Use this when the user asks for a summary, overview, or wants to know what the page is about."""
        if not body.text.strip():
            return "No page content available."
        max_chars = 15000
        text = body.text.strip()
        if len(text) > max_chars:
            return text[:max_chars] + "\n\n[Content truncated — page is very long]"
        return text

    # ── Define the web_search tool (Tavily) ─────────────────────────────────────
    tools = [search_page, summarize_page]

    tavily_key = (body.tool_keys or {}).get("tavily")
    if tavily_key:
        from tavily import TavilyClient
        tavily_client = TavilyClient(api_key=tavily_key)

        @tool
        def web_search(query: str) -> str:
            """Search the internet for up-to-date information.
            Use this when the user asks about something not found on the current page,
            or needs external facts, news, or verification."""
            results = tavily_client.search(query, max_results=3)
            return "\n\n".join(
                f"{r['title']}\n{r['content']}" for r in results.get("results", [])
            )

        tools.append(web_search)

    # ── Composio meta tools ──────────────────────────────────────────────────
    composio_key = (body.tool_keys or {}).get("composio")
    if composio_key:
        from composio import Composio
        from composio_langchain import LangchainProvider
        composio = Composio(api_key=composio_key, provider=LangchainProvider())
        session = composio.create(user_id="default")
        composio_tools = session.tools()
        tools.extend(composio_tools)

    # ── Build the ReAct agent ─────────────────────────────────────────────────
    agent = create_react_agent(
        model=llm,
        tools=tools,
        prompt=(
            "You are SiteWhisper, a helpful AI assistant. "
            "You have access to tools — use them when they can help answer the user's question. "
            "If no tool is needed, answer directly from your knowledge."
        ),
    )

    # ── Build message history ─────────────────────────────────────────────────
    messages = []
    for h in (body.history or []):
        if h.get("role") == "user":
            messages.append(HumanMessage(content=h["content"]))
        elif h.get("role") == "assistant":
            messages.append(AIMessage(content=h["content"]))
    messages.append(HumanMessage(content=body.query))

    # ── Stream the agent response ─────────────────────────────────────────────
    async def generate():
        yield f"data: {json.dumps({'status': 'started'})}\n\n"
        try:
            async with asyncio.timeout(LLM_TIMEOUT):
                async for chunk in agent.astream(
                    {"messages": messages}, stream_mode="messages"
                ):
                    msg, metadata = chunk
                    if hasattr(msg, "tool_calls") and msg.tool_calls:
                        for tc in msg.tool_calls:
                            yield f"data: {json.dumps({'tool': tc['name']})}\n\n"
                    if metadata.get("langgraph_node") == "tools":
                        continue
                    if not hasattr(msg, "content"):
                        continue
                    content = msg.content
                    if isinstance(content, list):
                        content = "".join(
                            block.get("text", "") if isinstance(block, dict) else str(block)
                            for block in content
                        )
                    if isinstance(content, str) and content:
                        yield f"data: {json.dumps({'text': content})}\n\n"
        except TimeoutError:
            yield f"data: {json.dumps({'error': f'LLM timed out after {LLM_TIMEOUT}s.'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': _sse_error_handler(e, provider)})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    workers = 1 if os.environ.get("RENDER") else 4
    uvicorn.run("server:app", host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), workers=workers)
