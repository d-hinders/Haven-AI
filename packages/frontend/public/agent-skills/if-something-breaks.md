## If something breaks

Client out of date? What changed: [/releases](/releases). If a Haven result carries `client_update`, that client is out of date: run its `upgrade_command` exactly as given — a connector command may name your pair with `--name <slug>` — then any repair line it prints, then retry. `required: true` means payments are refused until you do.

Something else wrong? `haven feedback submit "<text>"` sends it to Haven — it needs `haven login` first. Never put a credential in that text: no API key, no delegate key, no session token, no recovery phrase.



---

Next: [Vocabulary](/agent-skills/vocabulary.md)
