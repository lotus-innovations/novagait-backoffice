# Novagait Back Office

[![CI](https://github.com/lotus-innovations/novagait-backoffice/actions/workflows/ci.yml/badge.svg)](https://github.com/lotus-innovations/novagait-backoffice/actions/workflows/ci.yml)

A production-grade AI agent demonstration by
[Lotus Innovations](https://lotusinnovations.io): accounts-payable invoice
intake with 3-way match for a fictional physical-therapy clinic, built the way
we build for clients. One workflow, one agent, with:

- a published evaluation report (golden dataset, failure taxonomy, judge
  calibration) at `/eval`
- a full per-run audit trail (every model call, tool call, token count, cost)
  at `/runs`
- human approval gates implemented in code, not prompts
- measured cost per run across the Claude model ladder, including cost per
  correct run
- shadow / assisted / autonomous rollout modes

Status: build in progress. Live demo (when released):
https://backoffice.lotusinnovations.io

> Demonstration project by Lotus Innovations. "Novagait" is a fictional
> brand; all data is synthetic. Not affiliated with any real clinic or
> entity.

## Layout

| Path                    | Contents                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| `apps/web`              | Next.js app: intake, run viewer, approvals, memory, backend, eval report |
| `packages/agent`        | Prompts, tool schemas, loop, guardrails, memory, pricing, trace          |
| `packages/mock-backend` | Fictional ERP, inbox, and records modules with seeded synthetic data     |
| `evals/runner`          | The evaluation harness (golden cases, graders, taxonomy, thresholds)     |

## Development

```
nvm use && npm install
npm run dev
```

CI is key-free by design: no Anthropic API key exists anywhere in GitHub.
Demo data is ephemeral by design; nothing in any demo store is worth backing
up.

## License

Source-visible demonstration project. (c) Lotus Innovations. All rights
reserved.
