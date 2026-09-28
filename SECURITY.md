# Security and privacy

Tab State handles people's browsing history, so security and privacy reports are taken seriously
and handled before anything else.

## Reporting a vulnerability

Please **don't open a public issue**. Instead, either:

- use GitHub's private reporting: the repository's **Security** tab →
  [**Report a vulnerability**](https://github.com/asyau/tab-state/security/advisories/new), or
- email **asyaunal02@gmail.com** with "Tab State security" in the subject.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a
reply within a few days, a fix as quickly as the severity calls for, and credit in the release
notes if you'd like it.

## What counts

Anything that could expose or tamper with a user's browsing data, for example:

- tab data reaching anyone other than the user — a web page, another extension, another program
- sending page text or selected text to a cloud service (Tab State promises never to)
- the local MCP server (`mcp-server/`): accepting data or requests it shouldn't — it must refuse web
  pages, foreign `Host` headers and non-JSON writes; see "Who can talk to it" in
  [mcp-server/README.md](mcp-server/README.md)
- ChatGPT remote mode: bypassing its token, or reaching the sync endpoint through it
- API keys (stored locally in the browser profile) leaking anywhere other than the provider the
  user chose

## Supported versions

Only the latest release on the Chrome Web Store (and `main`) receives fixes.
