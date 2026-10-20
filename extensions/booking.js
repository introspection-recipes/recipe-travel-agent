// Flight Sector booking tools: plain HTTPS calls through the platform's egress.
// A trip is an AAuth mission: the agent proposes it to the traveller's Person
// Server, which the egress reaches at person-server.aauth, and the traveller's
// company approves it once. Bookings then go to the `aauth` booking connector;
// egress signs them and gets each auth token under the mission. Nothing here
// holds a credential; anything awaiting a person comes back as 428, and the
// runtime reports it.
import { Type } from "typebox";

// Required: the booking provider's real URL, set as a project variable. The
// project's AAuth connector must list its host in `api_hosts` for the egress to
// sign for it.
const BOOKING_API_URL = (process.env.BOOKING_API_URL ?? "").trim().replace(/\/$/, "");
const PERSON_SERVER_URL = "https://person-server.aauth";
const REQUEST_TIMEOUT_MS = 20_000;
// A service that is down does not come back for a retry a second later, so
// after this many failures in a row the agent is told to stop.
const MAX_FAILURES_IN_A_ROW = 2;
let failuresInARow = 0;

const NOT_CONFIGURED = {
  content: [
    {
      type: "text",
      text:
        "Booking is not configured: the project has no BOOKING_API_URL variable. " +
        "It needs that variable set to the booking provider's URL, and an AAuth connector whose api_hosts includes that host. " +
        "Retrying will not help. Tell the employee booking is not set up yet, and that whoever runs this agent needs to configure it. Then stop.",
    },
  ],
  details: { status: 0, reason: "booking_api_url_unset" },
  isError: true,
};

const DNS_ERRORS = new Set(["ENOTFOUND", "EAI_AGAIN"]);

function errorCode(err) {
  // fetch wraps the socket error, sometimes twice.
  for (let e = err; e; e = e.cause) if (typeof e.code === "string") return e.code;
  return undefined;
}

async function call(path, body, signal, base = BOOKING_API_URL) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const host = URL.canParse(base) ? new URL(base).host : base;
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return {
      status: response.status,
      text: await response.text(),
      contentType: response.headers.get("content-type") ?? "",
      host,
    };
  } catch (err) {
    // A stopped run ends here; anything else is a service that did not answer.
    if (signal?.aborted) throw err;
    return { status: 0, text: timeout.aborted ? "timed out" : String(err?.message ?? err), code: errorCode(err), host };
  }
}

const POLICY_DENIED = "https://introspection.dev/problems/policy-denied";
const UPSTREAM_UNREACHABLE = "/problems/upstream-unreachable";

function refusedByPolicy(res) {
  if (res.status !== 403) return false;
  try {
    return JSON.parse(res.text).type === POLICY_DENIED;
  } catch {
    return false;
  }
}

// An RFC 9457 problem, whether or not it was labelled application/problem+json.
function problemOf(res) {
  if (res.status === 0) return undefined;
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object") return undefined;
  if (!res.contentType?.includes("application/problem+json") && typeof body.type !== "string") return undefined;
  const problem = {};
  for (const key of ["type", "title", "detail", "host", "reason"])
    if (typeof body[key] === "string") problem[key] = body[key];
  return problem;
}

function describe(problem) {
  const lines = [`Problem: ${problem.type ?? "about:blank"}`];
  if (problem.title) lines.push(`Title: ${problem.title}`);
  if (problem.detail) lines.push(`Detail: ${problem.detail}`);
  if (problem.host) lines.push(`Host: ${problem.host}`);
  if (problem.reason) lines.push(`Reason: ${problem.reason}`);
  return lines.join("\n");
}

function result(res) {
  const decided = res.status === 428 || refusedByPolicy(res);
  const problem = decided ? undefined : problemOf(res);

  // An upstream that does not resolve or refuses connections is a setup fault,
  // not an outage: no number of retries fixes it.
  const unreachable = problem?.type?.endsWith(UPSTREAM_UNREACHABLE);
  if (unreachable || (res.status === 0 && DNS_ERRORS.has(res.code))) {
    const host = problem?.host ?? res.host;
    const reason = problem?.reason ?? (res.code ? "dns_resolution_failed" : "unreachable");
    const text =
      (res.status === 0 ? `No response: ${res.text}` : `HTTP ${res.status}\n${describe(problem)}`) +
      `\n\nBooking is misconfigured: ${host} cannot be reached (${reason}). Retrying will not help. ` +
      "Tell the employee booking is not set up correctly, not that they should try again later, " +
      "and what is already booked. Then stop.";
    return {
      content: [{ type: "text", text }],
      details: { status: res.status, misconfigured: true, host, reason, ...(res.code && { code: res.code }), ...(problem && { problem }) },
      isError: true,
    };
  }

  const unavailable = res.status === 0 || res.status === 401 || res.status >= 500;
  failuresInARow = unavailable ? failuresInARow + 1 : 0;
  let text = res.status === 0 ? `No response: ${res.text}` : `HTTP ${res.status}\n${res.text}`;
  if (problem) text += `\n\n${describe(problem)}`;
  if (failuresInARow >= MAX_FAILURES_IN_A_ROW)
    text +=
      `\n\n${failuresInARow} failures in a row: the service is not answering. Do not retry. ` +
      "Tell the employee what is not working and what is already booked, and that they can ask again later. Then stop.";
  return {
    content: [{ type: "text", text }],
    details: { status: res.status, ...(problem && { problem }) },
    // A 428 is the approval steer and a policy refusal is a decision; each carries what to tell the person.
    isError: res.status === 0 || (res.status >= 400 && !decided),
  };
}

// Each offer's signed quote, by offer_id. The model books an offer by its id
// and never handles the token: a long signature copied by hand can lose a
// character, and the provider then refuses a quote it no longer recognises.
// The reserve request still carries the quote, which the egress's rails read.
const quotes = new Map();

/** Keep the quotes a search or quote answered with, and show the model the offers without them. */
function keepQuotes(res) {
  if (res.status !== 200) return res;
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    return res;
  }
  const offers = [...(Array.isArray(body?.offers) ? body.offers : []), ...(body?.offer ? [body.offer] : [])];
  for (const offer of offers) {
    if (typeof offer?.offer_id === "string" && typeof offer.quote === "string") {
      quotes.set(offer.offer_id, offer.quote);
      delete offer.quote;
    }
  }
  return { ...res, text: JSON.stringify(body) };
}

const NO_QUOTE = (offerId) => ({
  content: [
    {
      type: "text",
      text: `No quote for ${offerId} in this session. Search or quote it again (search_offers or quote_flight), then book the offer_id it returns.`,
    },
  ],
  details: { status: 0, reason: "no_quote", offer_id: offerId },
  isError: true,
});

export function registerBookingTools(pi) {
  pi.registerTool({
    name: "today",
    label: "Today's date",
    description: "Today's date and weekday, to work out a date the traveller gives relative to now, such as \"next Monday\".",
    parameters: Type.Object({}),
    async execute() {
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
      return { content: [{ type: "text", text: `${weekday} ${date}` }], details: { date, weekday } };
    },
  });

  pi.registerTool({
    name: "propose_trip",
    label: "Propose the trip",
    description:
      "Propose the whole trip to the traveller's company before booking anything. Its manager approves it once and sets its budget; bookings within it then need no one. Returns the approved mission (its `budget_cents` is the budget the manager set) and its `s256`.",
    promptSnippet: "Propose the trip, with its budget, before booking anything.",
    promptGuidelines: [
      "Describe the trip in Markdown: who travels, where, when, each thing to be booked with its quoted price, and a suggested budget as \"up to $N\" for their quoted total, naming the employee's own budget too when it is lower. The manager sets the actual budget.",
      "Propose once per trip, before the first booking.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "Markdown: the trip with each quoted price, ending with a suggested budget for their total, e.g. 'up to $4,860'" }),
    }),
    async execute(_toolCallId, params, signal) {
      return result(await call("/mission", { description: params.description }, signal, PERSON_SERVER_URL));
    },
  });

  pi.registerTool({
    name: "complete_trip",
    label: "Report the trip booked",
    description: "Tell the traveller's company the trip is booked. The traveller accepts it, which ends the mission.",
    parameters: Type.Object({
      s256: Type.String({ description: "The mission's s256, from propose_trip or its approval" }),
      summary: Type.String({ description: "Markdown: what was booked, and the total" }),
    }),
    async execute(_toolCallId, params, signal) {
      return result(
        await call(`/mission/${params.s256}`, { action: "completion", summary: params.summary }, signal, PERSON_SERVER_URL),
      );
    },
  });

  pi.registerTool({
    name: "search_offers",
    label: "Search travel",
    description:
      "Search flights or hotels. Book an offer by passing its `offer_id` to book_item.",
    promptSnippet: "Search flights or hotels for signed, bookable offers.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("flight"), Type.Literal("hotel")]),
      from: Type.Optional(Type.String({ description: "Flight origin IATA code, e.g. SFO" })),
      to: Type.Optional(Type.String({ description: "Flight destination IATA code, e.g. SYD" })),
      date: Type.Optional(Type.String({ description: "Flight date, YYYY-MM-DD" })),
      cabin: Type.Optional(Type.String({ description: "economy, premium, business or first" })),
      city: Type.Optional(Type.String({ description: "Hotel city IATA code, e.g. SYD" })),
      check_in: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
      check_out: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (!BOOKING_API_URL) return NOT_CONFIGURED;
      return result(keepQuotes(await call("/v1/search", params, signal)));
    },
  });

  pi.registerTool({
    name: "quote_flight",
    label: "Quote a flight",
    description:
      "Get a bookable offer for a flight found in a browser search. The booking provider quotes its own fare, which can differ from the price the search showed; book it by passing its `offer_id` to book_item.",
    promptSnippet: "Quote a flight found in a browser search, for a bookable offer.",
    parameters: Type.Object({
      from: Type.String({ description: "Origin IATA code, e.g. SFO" }),
      to: Type.String({ description: "Destination IATA code, e.g. SYD" }),
      date: Type.String({ description: "YYYY-MM-DD" }),
      carrier: Type.Optional(Type.String({ description: "Airline as the search showed it, e.g. Qantas" })),
      flight: Type.Optional(Type.String({ description: "Flight number, when the search showed one, e.g. QF74" })),
      cabin: Type.Optional(Type.String({ description: "economy, premium_economy, business or first" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (!BOOKING_API_URL) return NOT_CONFIGURED;
      return result(keepQuotes(await call("/v1/quote", params, signal)));
    },
  });

  pi.registerTool({
    name: "book_item",
    label: "Book travel",
    description:
      "Reserve one offer under the approved trip. Within its budget that is immediate; over what is left, it goes to the traveller's manager.",
    promptSnippet: "Reserve one signed offer the traveller has confirmed.",
    promptGuidelines: [
      "Set purpose to business only for legs that serve the work trip; anything else is personal with payer traveler.",
      "Book one item per call, and only after the traveller has confirmed it.",
    ],
    parameters: Type.Object({
      offer_id: Type.String({ description: "The offer_id from search_offers or quote_flight" }),
      purpose: Type.Union([Type.Literal("business"), Type.Literal("personal")]),
      payer: Type.Union([Type.Literal("company"), Type.Literal("traveler")]),
    }),
    async execute(_toolCallId, params, signal) {
      if (!BOOKING_API_URL) return NOT_CONFIGURED;
      const quote = quotes.get(params.offer_id);
      if (!quote) return NO_QUOTE(params.offer_id);
      return result(await call("/v1/reserve", { ...params, quote }, signal));
    },
  });
}

export default function (pi) {
  registerBookingTools(pi);
}
