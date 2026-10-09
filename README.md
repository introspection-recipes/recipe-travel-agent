# Travel Agent Recipe

A Git-backed Introspection recipe: **Flight Sector's travel agent**, which books
work travel for a company's employees from a Slack DM, through an `aauth`
**connector**. The booking provider is a native [AAuth](https://github.com/dickhardt/AAuth)
resource and the employee's company runs the Person Server that speaks for
them. Each trip is an AAuth **mission**: the manager approves it once, budget
and all; a booking within it goes through at once, and one over what is left
waits for the manager.

Design: `introspection-cloud/docs/design/connectors-aauth-b2b2c.md` (§12.2 the
AAuth agent, §12.3 missions, §18 the `connectors:` recipe block, §19 the rails).

## What this demonstrates

- An agent that acts **on behalf of a person**, never on its own authority.
- **No credential in the sandbox**: the platform is the Agent Provider. Egress
  signs each request (RFC 9421) with the session's key and presents the best
  token it holds; the provider answers with a resource token, and egress
  exchanges it at the company's Person Server for an auth token.
- **A trip is a mission**: `propose_trip` proposes the whole trip, with its
  budget, before anything is booked; `complete_trip` ends it. The mission and
  its tokens stay in the egress; the agent holds only its `s256`.
- **The company decides**: Acme's Person Server weighs each booking against
  what is left of the trip's budget, and asks the manager when it is over.
  `pending` is a first-class state, not an error: the agent is told, and the
  chat resumes when the manager decides.

## The full scope

A booking passes four layers. The connector is the standing capability, the
recipe references it, the recipe's **policies** are the builder's deterministic
rails, and the traveller's **company** decides each booking through its Person
Server. Each layer can only narrow what the next one sees.

### 1. Connector — the org-side definition (Control Plane)

Created once, org-side (the "Add connector" UI / `POST /v1/connectors`). This is
the security boundary: which provider, which action scopes, and which Person Server
speaks for the people it serves.

```jsonc
{
  "name": "Booking",
  "provider": "booking",
  "auth_mode": "aauth",
  "subject_scope": "person",
  "scopes": ["booking.reserve"],              // the action classes this connector allows
  "api_hosts": ["api.booking.example"],       // egress allowlist; egress signs requests to these
  "person_server_url": "https://ps.acme.example", // the agent token's `ps`: where egress exchanges resource tokens
  "application_id": "…",                      // the Agent Provider client the agent token names
  "policy_entities": [                        // what policies/ may read about each customer company
    { "uid": { "type": "Company", "id": "acme" }, "attrs": { "business_min_level": 5 }, "parents": [] }
  ]
}
```

`approval_policy` lives **here, not in the recipe** — a recipe author cannot set
the org's security boundary. The judge is an approver rung *under* a
human-granted policy, never the boundary itself.

### 2. Recipe — the agent references + scopes the connector

Planned: `agents/agent.yaml` will name connectors and narrow scopes (the same
split as MCP servers — the definition is org-side). The recipe loader rejects
unknown keys today, so this block is not in the file yet:

```yaml
connectors:
  booking:
    subject: person          # act on the customer's behalf
    scopes: [booking.reserve] # subset of the connector's scopes this agent needs
  gmail:
    subject: person
    scopes: [gmail.send]
  stripe: # payment step-up: a second, higher-stakes approval
    subject: person
    scopes: [charge]
```

### 3. Policies — the builder's rails (`policies/`)

[Cedar](https://www.cedarpolicy.com/) policies, versioned with the agent's code,
evaluated in the platform's egress on **every request** to a connector host,
before the traveller's company is asked
(`introspection-cloud` `docs/design/connectors-aauth-b2b2c.md` §19):

```cedar
// policies/travel.cedar
@id("missionless-booking")
@reason("propose the trip first: a booking needs the traveller's approved mission")
forbid (principal, action == Action::"booking.reserve", resource)
unless { context has mission };

@id("business-by-seniority")
@reason("business class on the company's account needs the company's seniority, on a leg of six hours or more")
forbid (principal, action == Action::"booking.reserve", resource)
when { resource has cabin && resource.cabin == "business" && resource.payer == "company" }
unless {
  principal has level && principal has company &&
  principal.level >= principal.company.business_min_level &&
  resource has block_minutes && resource.block_minutes >= 360
};
```

A deny ends the request with its reason; an allow only lets it on to the
company's Person Server, which still decides. The same rule answers per person:
`level` is set by an org owner on the member, and `company` is an entity the
booking connector carries. See [`policies/README.md`](policies/README.md).

### 4. The company decides — AAuth (runtime)

The tool sends the offer's signed quote, purpose and payer; nothing in it knows
about AAuth. What happens next is the platform's and the company's
(`introspection-cloud` `docs/design/connectors-aauth-b2b2c.md` §12.2–§12.3):

1. `propose_trip` posts the trip to `https://person-server.aauth/mission`; the
   egress takes it to the company's Person Server, and the manager approves it.
2. The egress signs each booking (RFC 9421) and presents the mission's person
   token.
3. The provider answers `401` with a resource token naming this one booking.
4. The egress takes it to the Person Server: within the trip's budget, an auth
   token at once; over what is left, `202` while it asks the manager.
5. When it is decided, the agent is told in the same DM and books again.
6. `complete_trip` proposes the trip done; the traveller accepts, and the
   mission ends.

## Status

- **Live on the platform branch:** the Agent Provider, egress signing and token
  exchange, AAuth missions, waiting on a `202`, and the policy gate.
- **Example:** `introspection-js-sdk` `examples/aauth-travel` runs the booking
  provider and Acme's Person Server.

## Register it as a runtime

Register alongside `coding-agent`: **New runtime → From existing recipe →** pick
this repo/branch → `.introspection/travel-agent.yaml`. Local dev seeds it via
`make seed-travel-agent` (wired into `make dev-partner`). It skips gracefully
until this repo is pushed + linked to the project; enable an explicit run with
`SEED_TRAVEL_AGENT_RUNTIME=true make seed-runtimes`.

## Layout

```text
.introspection/travel-agent.yaml   # the GitOps manifest Introspection discovers
agents/agent.yaml                  # the runnable travel agent
extensions/booking.js              # search_offers + book_item, plain HTTPS calls
policies/                          # Cedar rails: schema, travel rules, connector routes
SYSTEM.md                          # the base system prompt
```
