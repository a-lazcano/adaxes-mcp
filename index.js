import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "node:http";
import { randomUUID } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────

const BASE_URL =
  process.env.ADAXES_BASE_URL || "https://adxs.saratoga-homes.com";
const AUTH_HEADER = process.env.ADAXES_AUTH_HEADER || "Adm-Authorization";
const AUTH_VALUE = process.env.ADAXES_AUTH_VALUE;

if (!AUTH_VALUE) {
  console.error("ADAXES_AUTH_VALUE is required");
  process.exit(1);
}

// ── Constants ───────────────────────────────────────────────────────

const DIVISION_CODES = {
  austin: "AUS",
  killeen: "AUS",
  "el paso": "ELP",
  houston: "HOU",
  "houston north": "HOU",
  "houston south": "HOU",
};

const STAGING_OU = "OU=Staging,OU=Domain Users,DC=SARATOGA-HOMES,DC=com";
const DEFAULT_PASSWORD = "Temp!12300";
const DEPROVISION_COMMAND_ID = "bac40afa-9780-49ad-bf88-f5c93b45d6f3";
const REQUEST_TIMEOUT_MS = Number(process.env.ADAXES_TIMEOUT_MS) || 30000;

// ── Helpers ─────────────────────────────────────────────────────────

async function adaxesRequest(path, body) {
  const url = `${BASE_URL}/restapi/api${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [AUTH_HEADER]: AUTH_VALUE,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `Adaxes request timed out after ${REQUEST_TIMEOUT_MS}ms: ${path}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Adaxes API ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// Property values come back as a plain value, an object with a .value key, or an
// array of either. Normalize to a scalar (or null when absent/empty).
function unwrapProperty(raw) {
  if (raw === undefined || raw === null) return null;
  const one = (v) =>
    v && typeof v === "object" && !Array.isArray(v) && "value" in v ? v.value : v;
  const val = Array.isArray(raw) ? raw.map(one).join(", ") : one(raw);
  return val === undefined || val === null || val === "" ? null : val;
}

function properCase(str) {
  return str
    .replace(/_/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function sanitizePhone(phone) {
  const digits = phone.replace(/\D/g, "");
  // Strip leading 1 if 11 digits (US country code)
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits;
}

function mapDivisionCode(division) {
  const code = DIVISION_CODES[division.toLowerCase()];
  if (!code) {
    throw new Error(
      `Unknown division "${division}". Valid: ${Object.keys(DIVISION_CODES).join(", ")}`
    );
  }
  return code;
}

// adm-CustomAttributeText2 = "Deprovision Ticket Number"
// adm-CustomAttributeDate2 = "User Deprovisioned On"
// Both are stamped by the Adaxes deprovision command, as is the "Deprovisioned <date>"
// marker in description. They are the only way to tell a deprovisioned account from one
// the HRMS merely disabled or the Disabled Users Sweep merely moved.
const DEPROVISION_TICKET_ATTR = "adm-CustomAttributeText2";
const DEPROVISION_DATE_ATTR = "adm-CustomAttributeDate2";

const SEARCH_PROPERTIES = [
  "displayName", "distinguishedName", "givenName", "sn", "sAMAccountName",
  "userPrincipalName", "mail", "employeeNumber", "department", "division", "title",
  "mobile", "telephoneNumber", "manager", "userAccountControl", "description",
  DEPROVISION_TICKET_ATTR, DEPROVISION_DATE_ATTR,
].join(",");

function buildSearchCriteria(property, value) {
  return {
    criteria: {
      objectTypes: [
        {
          type: "user",
          items: {
            type: 1,
            items: [
              {
                $type: 0,
                type: 0,
                property,
                operator: "eq",
                values: [{ type: 2, value }],
                valueLogicalOperator: 0,
              },
            ],
            logicalOperator: 1,
          },
        },
      ],
    },
    select: { properties: SEARCH_PROPERTIES },
  };
}

function formatSearchResults(data) {
  if (!data || (Array.isArray(data) && data.length === 0)) {
    return "No users found.";
  }

  const users = Array.isArray(data) ? data : data.results || data.directoryObjects || [data];
  if (users.length === 0) return "No users found.";

  return users
    .map((u, i) => {
      const lines = [`--- User ${i + 1} ---`];
      // Top-level defaults (always present)
      if (u.displayName) lines.push(`displayName: ${u.displayName}`);
      const dn = u.distinguishedName || u.dn;
      if (dn) lines.push(`distinguishedName: ${dn}`);
      // Requested properties (values are arrays, unwrap single-valued)
      const props = u.properties || {};
      const fields = [
        "givenName", "sn", "sAMAccountName", "userPrincipalName", "mail",
        "employeeNumber", "department", "division", "title",
        "mobile", "telephoneNumber", "manager", "userAccountControl", "description",
      ];
      for (const f of fields) {
        const val = unwrapProperty(props[f]);
        if (val !== null) lines.push(`${f}: ${val}`);
      }
      if (u.accountStatus) {
        lines.push(`accountStatus: ${JSON.stringify(u.accountStatus)}`);
      }

      // Deprovision state. A disabled account, and an account sitting in
      // OU=Disabled Objects, are both produced by other processes (the HRMS disable and
      // the Disabled Users Sweep). Only these stamps prove the deprovision command ran.
      const deproTicket = unwrapProperty(props[DEPROVISION_TICKET_ATTR]);
      const deproDate = unwrapProperty(props[DEPROVISION_DATE_ATTR]);
      const deproDesc = /^\s*Deprovisioned\s+\d{8}/i.test(
        unwrapProperty(props.description) || ""
      );
      lines.push(`deprovisionTicketNumber: ${deproTicket ?? "(blank)"}`);
      lines.push(`userDeprovisionedOn: ${deproDate ?? "(blank)"}`);
      const deprovisioned = Boolean(deproTicket || deproDate || deproDesc);
      lines.push(
        deprovisioned
          ? "deprovisioned: true (Adaxes deprovision has run against this account)"
          : "deprovisioned: false (NOT deprovisioned - disabled state and the Disabled " +
            "Objects OU do NOT indicate otherwise; run adaxes_deprovision_user)"
      );
      return lines.join("\n");
    })
    .join("\n\n");
}

// ── MCP Server ──────────────────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({
    name: "adaxes-mcp",
    version: "1.0.0",
  });

  server.tool(
    "adaxes_search_user",
    [
      "Search Active Directory for a user via Adaxes.",
      "Provide either an employee ID or a display name (first and last).",
      "Returns a `deprovisioned: true/false` verdict alongside the raw stamps",
      "(deprovisionTicketNumber, userDeprovisionedOn, description). Use that verdict:",
      "a disabled account, and an account sitting in OU=Disabled Objects, are both",
      "produced by the HRMS disable and the Disabled Users Sweep respectively, and mean",
      "NOTHING about whether the account was actually offboarded.",
    ].join(" "),
    {
      employee_id: z
        .string()
        .optional()
        .describe("Employee number to search by"),
      display_name: z
        .string()
        .optional()
        .describe("Full display name (e.g. 'John Smith') to search by"),
    },
    async ({ employee_id, display_name }) => {
      if (!employee_id && !display_name) {
        return {
          content: [
            {
              type: "text",
              text: "Error: provide either employee_id or display_name.",
            },
          ],
        };
      }

      const property = employee_id ? "employeeNumber" : "displayName";
      const value = employee_id || display_name;
      const body = buildSearchCriteria(property, value);

      try {
        const data = await adaxesRequest("/directoryObjects/search", body);
        return {
          content: [{ type: "text", text: formatSearchResults(data) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Search failed: ${err.message}` }],
        };
      }
    }
  );

  server.tool(
    "adaxes_create_user",
    [
      "Provision a new Active Directory user account via Adaxes.",
      "The server handles: name capitalization, phone sanitization, division-to-code mapping,",
      "username generation (first.last), manager DN lookup, and all hardcoded defaults",
      "(staging OU, temp password, account flags).",
      "The manager_name will be looked up in AD to resolve their distinguished name.",
    ].join(" "),
    {
      first_name: z.string().describe("First name"),
      last_name: z.string().describe("Last name"),
      employee_number: z.string().describe("Employee number"),
      division: z
        .string()
        .describe(
          "Division name: Austin, Killeen, El Paso, Houston, Houston North, or Houston South"
        ),
      department: z.string().describe("Department name"),
      title: z.string().describe("Job title"),
      phone: z.string().describe("Phone number (any format, will be sanitized to 10 digits)"),
      manager_name: z
        .string()
        .describe("Manager's full name (will be searched in AD to get their DN)"),
      ticket_id: z
        .string()
        .describe("Zendesk ticket ID (4-digit number) for tracking"),
    },
    async ({
      first_name,
      last_name,
      employee_number,
      division,
      department,
      title,
      phone,
      manager_name,
      ticket_id,
    }) => {
      try {
        // Sanitize inputs
        const firstName = properCase(first_name);
        const lastName = properCase(last_name);
        const displayName = `${firstName} ${lastName}`;
        const username = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`;
        const mobile = sanitizePhone(phone);
        const divisionCode = mapDivisionCode(division);

        if (mobile.length !== 10) {
          return {
            content: [
              {
                type: "text",
                text: `Error: phone number must be 10 digits after sanitization, got ${mobile.length} digits ("${mobile}" from "${phone}").`,
              },
            ],
          };
        }

        if (!/^\d{4}$/.test(ticket_id)) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ticket_id must be a 4-digit number, got "${ticket_id}".`,
              },
            ],
          };
        }

        // Look up manager DN
        const managerSearch = buildSearchCriteria("displayName", manager_name);
        const managerResults = await adaxesRequest(
          "/directoryObjects/search",
          managerSearch
        );

        const managers = Array.isArray(managerResults)
          ? managerResults
          : managerResults?.results ||
            managerResults?.directoryObjects ||
            [];

        if (managers.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Error: manager "${manager_name}" not found in AD. Cannot create user without a valid manager DN.`,
              },
            ],
          };
        }

        const managerDn =
          managers[0].distinguishedName || managers[0].dn || null;
        if (!managerDn) {
          return {
            content: [
              {
                type: "text",
                text: `Error: found manager "${manager_name}" but could not extract their distinguished name from the response: ${JSON.stringify(managers[0])}`,
              },
            ],
          };
        }

        // Build create payload
        const createBody = {
          createIn: STAGING_OU,
          objectType: "user",
          properties: [
            { propertyName: "cn", propertyType: "String", values: [displayName] },
            { propertyName: "displayName", propertyType: "String", values: [displayName] },
            { propertyName: "givenName", propertyType: "String", values: [firstName] },
            { propertyName: "sn", propertyType: "String", values: [lastName] },
            { propertyName: "userPrincipalName", propertyType: "String", values: [username] },
            { propertyName: "sAMAccountName", propertyType: "String", values: [username] },
            { propertyName: "Department", propertyType: "String", values: [department] },
            { propertyName: "division", propertyType: "String", values: [divisionCode] },
            { propertyName: "employeeNumber", propertyType: "String", values: [employee_number] },
            { propertyName: "mobile", propertyType: "String", values: [mobile] },
            { propertyName: "title", propertyType: "String", values: [title] },
            { propertyName: "manager", propertyType: "String", values: [managerDn] },
            { propertyName: "unicodePwd", propertyType: "String", values: [DEFAULT_PASSWORD] },
            { propertyName: "adm-CustomAttributeText1", propertyType: "String", values: [ticket_id] },
            { propertyName: "userAccountControl", propertyType: "Integer", values: [-2147483648] },
            { propertyName: "accountExpires", propertyType: "Timestamp", values: ["Never"] },
          ],
        };

        const result = await adaxesRequest("/directoryObjects", createBody);

        const summary = [
          `User created successfully.`,
          `Display Name: ${displayName}`,
          `Username: ${username}`,
          `Employee #: ${employee_number}`,
          `Division: ${division} (${divisionCode})`,
          `Department: ${department}`,
          `Title: ${title}`,
          `Phone: ${mobile}`,
          `Manager: ${manager_name} (${managerDn})`,
          `Created In: ${STAGING_OU}`,
          `Ticket: ${ticket_id}`,
          `Temporary Password: ${DEFAULT_PASSWORD}`,
        ];

        if (result) {
          summary.push(`\nAdaxes response: ${JSON.stringify(result)}`);
        }

        return { content: [{ type: "text", text: summary.join("\n") }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `User creation failed: ${err.message}` },
          ],
        };
      }
    }
  );

  server.tool(
    "adaxes_deprovision_user",
    [
      "Deprovision an Active Directory user account via Adaxes: disable, randomize the",
      "password, cancel meetings, deactivate Microsoft 365 and revoke licenses, remove",
      "security groups, move to the Disabled Objects OU, and archive mailbox/home drive.",
      "Requires the user's CURRENT distinguished name (use adaxes_search_user first; a",
      "stale DN 404s if the object has already moved) and the Zendesk ticket ID for audit",
      "tracking. Safe to re-run, including against an account that is already disabled or",
      "already in OU=Disabled Objects. Often exceeds the 30s request timeout while still",
      "completing server-side - on a timeout do not retry blindly, confirm via the ticket.",
    ].join(" "),
    {
      distinguished_name: z
        .string()
        .describe(
          "The user's full AD distinguished name (e.g. CN=John Smith,OU=Sales,DC=SARATOGA-HOMES,DC=com)"
        ),
      ticket_id: z
        .string()
        .describe("Zendesk ticket ID for audit tracking"),
    },
    async ({ distinguished_name, ticket_id }) => {
      try {
        const body = {
          directoryObject: distinguished_name,
          customCommandId: DEPROVISION_COMMAND_ID,
          parameters: [
            {
              type: "Text",
              name: "param-DeprovisionTicketNumber",
              value: ticket_id,
            },
          ],
        };

        const result = await adaxesRequest(
          "/directoryObjects/customCommand/execute",
          body
        );

        const summary = [
          `Deprovision executed successfully.`,
          `User: ${distinguished_name}`,
          `Ticket: ${ticket_id}`,
          `Command ID: ${DEPROVISION_COMMAND_ID}`,
        ];

        if (result) {
          summary.push(`\nAdaxes response: ${JSON.stringify(result)}`);
        }

        return { content: [{ type: "text", text: summary.join("\n") }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Deprovision failed: ${err.message}` },
          ],
        };
      }
    }
  );

  return server;
}

// ── HTTP Server ─────────────────────────────────────────────────────

const transports = new Map();

const httpServer = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if (pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  console.log(
    `[MCP] ${req.method} /mcp session=${req.headers["mcp-session-id"] || "none"}`
  );

  try {
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId).handleRequest(req, res);
      return;
    }

    if (req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
        transport.onclose = () => transports.delete(transport.sessionId);
        console.log(`[MCP] New session: ${transport.sessionId}`);
      }
      return;
    }

    if (req.method === "GET") {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("No valid session for SSE");
      return;
    }

    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request");
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }
});

const PORT = process.env.PORT || 3002;
httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`Adaxes MCP server listening on 127.0.0.1:${PORT}`);
});
