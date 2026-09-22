#!/usr/bin/env -S node --no-warnings
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.NODE_NO_WARNINGS = "1";
const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
setGlobalDispatcher(new EnvHttpProxyAgent());

const DEFAULT_EVENTS = [
  "download_png",
  "download_pdf",
  "change_bead_width_preset",
  "change_color_limit",
  "change_color_simplification",
  "toggle_remove_background",
  "toggle_dark_outline",
];

const root = process.cwd();
const credentialIndexPath = path.join(root, "notes/credentials/google-analytics-data-api.md");

function parseArgs(argv) {
  const args = {
    days: 28,
    recentDays: 7,
    events: DEFAULT_EVENTS,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    i += 1;

    if (key === "days" || key === "recentDays") {
      args[key] = Number(value);
    } else if (key === "events") {
      args.events = value.split(",").map((event) => event.trim()).filter(Boolean);
    } else {
      args[key] = value;
    }
  }

  if (!args.site && !args.propertyId) {
    throw new Error("Pass --site <domain> or --property-id <id>.");
  }
  if (!Number.isInteger(args.days) || args.days <= 0) {
    throw new Error("--days must be a positive integer.");
  }
  if (!Number.isInteger(args.recentDays) || args.recentDays <= 0) {
    throw new Error("--recent-days must be a positive integer.");
  }

  return args;
}

function readCredentialIndex() {
  return fs.readFileSync(credentialIndexPath, "utf8");
}

function resolveKeyPath(rawPath) {
  return path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath);
}

function parseKeyPaths(markdown) {
  return Array.from(markdown.matchAll(/key file: `([^`]+\.json)`/gi), (match) => resolveKeyPath(match[1]));
}

function parseProperties(markdown) {
  const blocks = markdown.split(/\n##\s+/).slice(1);
  const properties = [];

  for (const block of blocks) {
    const site = block.match(/Site:\s*`([^`]+)`/i)?.[1];
    const propertyId = block.match(/Property ID:\s*`([^`]+)`/i)?.[1];
    const measurementId = block.match(/Measurement ID:\s*`([^`]+)`/i)?.[1];
    const propertyName = block.match(/Property:\s*`([^`]+)`/i)?.[1];
    if (site && propertyId) {
      properties.push({ site, propertyId, measurementId, propertyName });
    }
  }

  return properties;
}

function selectProperty(args, markdown) {
  if (args.propertyId) {
    return { site: args.site ?? null, propertyId: args.propertyId };
  }

  const normalizedSite = args.site.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  const property = parseProperties(markdown).find((entry) => entry.site.replace(/^www\./, "") === normalizedSite);
  if (!property) {
    throw new Error(`No GA4 property found for site: ${args.site}`);
  }
  return property;
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getToken(keyPath) {
  const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(key.private_key);
  const jwt = `${signingInput}.${b64url(signature)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });

  if (!res.ok) {
    throw new Error(`token ${res.status} ${await res.text()}`);
  }

  return { accessToken: (await res.json()).access_token, clientEmail: key.client_email };
}

async function runReport(accessToken, propertyId, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();

  if (!res.ok) {
    const error = new Error(`report ${res.status} ${text}`);
    error.status = res.status;
    error.body = text;
    throw error;
  }

  return JSON.parse(text);
}

function table(report) {
  const dims = report.dimensionHeaders?.map((header) => header.name) ?? [];
  const mets = report.metricHeaders?.map((header) => header.name) ?? [];
  return (report.rows ?? []).map((row) => Object.fromEntries([
    ...dims.map((name, index) => [name, row.dimensionValues[index]?.value]),
    ...mets.map((name, index) => [name, row.metricValues[index]?.value]),
  ]));
}

function pageFilter(pathFilter) {
  if (!pathFilter) return null;
  return {
    filter: {
      fieldName: "pagePath",
      stringFilter: { matchType: "CONTAINS", value: pathFilter, caseSensitive: false },
    },
  };
}

function eventFilter(events) {
  if (!events.length) return null;
  return {
    orGroup: {
      expressions: events.map((value) => ({
        filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value } },
      })),
    },
  };
}

function andFilter(...expressions) {
  const present = expressions.filter(Boolean);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { andGroup: { expressions: present } };
}

async function buildReports(accessToken, propertyId, args) {
  const dateRanges = [
    { name: `last${args.days}d`, startDate: `${args.days}daysAgo`, endDate: "yesterday" },
    { name: `recent${args.recentDays}d`, startDate: `${args.recentDays}daysAgo`, endDate: "yesterday" },
  ];
  const summaryDateRanges = [
    ...dateRanges,
    {
      name: `previous${args.recentDays}d`,
      startDate: `${args.recentDays * 2}daysAgo`,
      endDate: `${args.recentDays + 1}daysAgo`,
    },
  ];
  const pFilter = pageFilter(args.path);
  const eFilter = eventFilter(args.events);

  const reports = {};
  reports.summary = table(await runReport(accessToken, propertyId, {
    dateRanges: summaryDateRanges,
    metrics: [
      { name: "activeUsers" },
      { name: "sessions" },
      { name: "engagedSessions" },
      { name: "engagementRate" },
      { name: "averageSessionDuration" },
      { name: "userEngagementDuration" },
      { name: "screenPageViews" },
      { name: "eventCount" },
    ],
    ...(pFilter ? { dimensionFilter: pFilter } : {}),
  }));
  reports.pages = table(await runReport(accessToken, propertyId, {
    dateRanges,
    dimensions: [{ name: "pagePath" }],
    metrics: [
      { name: "screenPageViews" },
      { name: "activeUsers" },
      { name: "sessions" },
      { name: "userEngagementDuration" },
      { name: "eventCount" },
    ],
    ...(pFilter ? { dimensionFilter: pFilter } : {}),
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    limit: 100,
  }));

  if (eFilter) {
    reports.eventsOnFilteredPages = table(await runReport(accessToken, propertyId, {
      dateRanges,
      dimensions: [{ name: "eventName" }, { name: "pagePath" }],
      metrics: [{ name: "eventCount" }, { name: "activeUsers" }],
      dimensionFilter: andFilter(pFilter, eFilter),
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
      limit: 10000,
    }));

    reports.allInstrumentedEvents = table(await runReport(accessToken, propertyId, {
      dateRanges,
      dimensions: [{ name: "eventName" }],
      metrics: [{ name: "eventCount" }, { name: "activeUsers" }],
      dimensionFilter: eFilter,
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
      limit: 100,
    }));
  }

  reports.trafficSource = table(await runReport(accessToken, propertyId, {
    dateRanges,
    dimensions: [{ name: "sessionDefaultChannelGroup" }, { name: "pagePath" }],
    metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }],
    ...(pFilter ? { dimensionFilter: pFilter } : {}),
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 100,
  }));

  reports.country = table(await runReport(accessToken, propertyId, {
    dateRanges,
    dimensions: [{ name: "country" }, { name: "pagePath" }],
    metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }],
    ...(pFilter ? { dimensionFilter: pFilter } : {}),
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
    limit: 100,
  }));

  return reports;
}

function summarize(result) {
  const { args, property, reports, credential } = result;
  const lines = [];
  lines.push(`GA4 property ${property.propertyId}${property.site ? ` (${property.site})` : ""}`);
  lines.push(`Credential: ${credential.clientEmail}`);
  lines.push(`Window: last ${args.days} days and last ${args.recentDays} days; path filter: ${args.path ?? "none"}`);
  lines.push("");
  lines.push("Pages:");
  lines.push(JSON.stringify(reports.pages, null, 2));
  if (reports.eventsOnFilteredPages) {
    lines.push("");
    lines.push("Events on filtered pages:");
    lines.push(JSON.stringify(reports.eventsOnFilteredPages, null, 2));
    lines.push("");
    lines.push("All instrumented events:");
    lines.push(JSON.stringify(reports.allInstrumentedEvents, null, 2));
  }
  lines.push("");
  lines.push("Traffic source:");
  lines.push(JSON.stringify(reports.trafficSource, null, 2));
  lines.push("");
  lines.push("Country:");
  lines.push(JSON.stringify(reports.country, null, 2));
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const markdown = readCredentialIndex();
  const property = selectProperty(args, markdown);
  const keyPaths = args.keyFile ? [resolveKeyPath(args.keyFile)] : parseKeyPaths(markdown);
  const errors = [];

  for (const keyPath of keyPaths) {
    try {
      const credential = await getToken(keyPath);
      const reports = await buildReports(credential.accessToken, property.propertyId, args);
      const result = { args, property, credential: { clientEmail: credential.clientEmail }, reports };
      console.log(args.json ? JSON.stringify(result, null, 2) : summarize(result));
      return;
    } catch (error) {
      errors.push(`${keyPath}: ${error.message}`);
      if (!String(error.message).includes("PERMISSION_DENIED")) {
        continue;
      }
    }
  }

  throw new Error(`No credential succeeded.\n${errors.join("\n")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
