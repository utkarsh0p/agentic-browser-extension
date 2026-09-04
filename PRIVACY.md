# Privacy Policy — SiteWhisper

**Last updated:** September 4, 2026

## What data does SiteWhisper read?

SiteWhisper reads the page you are viewing only when you send it a message. Nothing is read in
the background, and nothing is read on pages you never ask about.

Two things are read:

- **The visible text** of the page, when answering a question needs it.
- **An element map** — a list of the page's interactive controls (buttons, links, form fields),
  giving each one its role, its visible label, and its current state.

**Passwords and other secret fields are never sent.** The element map reports only that a field
has a value and how many characters it is, never the value itself.

## What SiteWhisper does on your behalf

SiteWhisper is not only a reader. When you ask it to do something, it can click, type, select,
check boxes, submit forms, and navigate — in the tab you asked from. It does not open or switch
tabs.

This can include acting inside sites where you are already signed in. You stay in control of it:

- **Restricted mode is the default.** In it, SiteWhisper asks for your approval before submitting
  a form, before clicking anything named like a consequential action (delete, buy, pay, send, and
  similar), and before typing into a password or payment field.
- **Unrestricted mode** runs those page actions without asking. It applies to page actions only,
  it is never remembered, and closing the panel always returns you to Restricted.
- **Actions in outside services** — sending an email through a connected account, for example —
  ask for approval in either mode.

When it needs a value it does not have, it asks you. Anything you type into such a prompt stays
in your browser: it is inserted into the page at the moment of typing, is never sent to the AI
model, and is never written to your saved conversation.

## How is the data used?

Your message, along with the page text or element map it needs, is sent to our backend server
(api.cember.in), which passes it to the AI provider you selected using your own API key. It is
used to produce that one answer or action. Page content is not stored, logged, or retained after
the response is returned.

No conversation history is sent to the AI model. Each message is handled on its own.

## API keys

Your API keys (for Claude, Gemini, GPT, or Groq) are stored locally in your browser using
`chrome.storage.local`. They are sent to our backend server only to authenticate requests with
that AI provider — they are never logged or stored on our server.

## Third-party services

Depending on your configuration, your message and the page content may be processed by:

- **Anthropic** (Claude), **Google** (Gemini), **OpenAI** (GPT), or **Groq** — to generate
  answers and decide actions

Each provider's own privacy policy applies to that interaction.

## Chat history

Your conversation is stored locally in your browser using `chrome.storage.local`, as one entry
per browser window. It stays as you browse — navigating, switching tabs, and opening or closing
tabs do not clear it — so that a conversation survives the work you are doing.

It is removed when you close that browser window, when you start a new chat, and whenever you
clear it yourself. Because it is keyed to a window, it does not survive restarting your browser.
This data never leaves your browser.

## Data sharing

SiteWhisper does not sell, share, or transfer user data to any third party for advertising,
analytics, or any purpose unrelated to the extension's core functionality.

## Contact

If you have questions about this privacy policy, contact: utkarshdevendrasingh@gmail.com
