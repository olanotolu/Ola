# Himalaya CLI setup (custom IMAP/SMTP)

Himalaya reads your inbox for reply detection. Outbound sends use Resend.

## Install

```bash
brew install himalaya
himalaya --version
```

## Configure account

Run the wizard or create `~/.config/himalaya/config.toml`:

```toml
[accounts.concya]
default = true
email = "hello@concya.com"
display-name = "Ola Adu"

backend.type = "imap"
backend.host = "imap.your-provider.com"
backend.port = 993
backend.encryption.type = "tls"
backend.login = "hello@concya.com"
backend.auth.type = "password"
backend.auth.cmd = "pass show himalaya/concya"  # or plain password in keyring

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.your-provider.com"
message.send.backend.port = 587
message.send.backend.encryption.type = "start-tls"
message.send.backend.login = "hello@concya.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "pass show himalaya/concya"
```

Use an **app-specific password** when your provider supports it.

## Test

```bash
npm run email:inbox:list
himalaya envelope list --account concya --folder INBOX --page-size 5 --output json
```

## Sync replies to CRM

```bash
npm run email:sync
```

Matches inbox replies to recent `crm_email_sends` and logs `replied` events in Supabase.
