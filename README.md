# adaxes-mcp

MCP server for Active Directory user management via the Adaxes REST API. Runs on port 3002 behind mcp-router.

## Tools

- `adaxes_search_user(employee_id?, display_name?)` -- search AD users
- `adaxes_create_user(first_name, last_name, employee_number, division, department, title, phone, manager_name, ticket_id)` -- provision new user with auto name casing, phone sanitization, division code mapping, and manager DN lookup
- `adaxes_deprovision_user(distinguished_name, ticket_id)` -- run deprovision custom command

## Auth

Custom header (`Adm-Authorization`) with auth value from env vars. Base URL: `https://adxs.saratoga-homes.com` (configurable).

## Setup

```
npm install
cp .env.example .env   # set ADAXES_AUTH_VALUE
node index.js
```

## Deploy

```
git push
ssh server
cd ~/adaxes-mcp && git pull && npm install && systemctl restart adaxes-mcp
```

## Dependencies

@modelcontextprotocol/sdk, dotenv, zod
