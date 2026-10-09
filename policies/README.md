# Policies: the agent builder's rails

`policies/` holds [Cedar](https://www.cedarpolicy.com/) policies that the
platform evaluates in its egress on every request to a connector host, before
the traveller's company is asked (introspection-cloud
`docs/design/connectors-aauth-b2b2c.md` §19).

| File | What it is |
| --- | --- |
| `schema.cedarschema` | The entities and actions the policies see |
| `*.cedar` | The rules |
| `routes.yaml` | For each connector, which requests map to which action, and where the resource's attributes come from |

There are two outcomes:

- **deny**: the agent gets `403` with the rule's `@reason`, and nothing else is asked.
- **allow**: the request goes on to the connector's own gate (the company's Person Server), which still decides.

A permit never replaces a person.

A route can ask for the session's approved AAuth mission as Cedar context
(`context: [mission]` gives `context.mission = {s256, resources}`).
`missionless-booking` uses it to refuse any booking outside an approved trip.

The same policy answers differently per person: the principal's `level` comes
from attributes an org owner sets on the member (`PATCH /v1/members/{id}`,
`policy_attributes`), and their `company` from entities the booking connector
carries (`policy_entities`). Policy that is the customer's own, such as
a trip's budget and who approves, stays with the customer's Person Server.

The platform reads these files at the deployed commit and fails closed: a
policy set that does not parse or validate denies every governed request. CI
validates them with the Cedar CLI (`.github/workflows/recipe-validation.yml`).
