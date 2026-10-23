#!/usr/bin/env python3
"""Ask the model to group and label the deployed resources, then verify the answer.

usage: generate.py <architecture-input.json> <plan.json>

The model never writes diagram code. It returns JSON that only references
resource addresses found in the input; anything else makes the script fail.
"""
import json
import os
import re
import sys
import urllib.request

GROUPS = ["network", "compute", "data", "observability"]
SYSTEM = f"""You document a cloud infrastructure from the list of resources that are really deployed.
Reply with ONE JSON object and nothing else, with this exact shape:
{{"groups": {{"network": [{{"address": "...", "label": "..."}}], "compute": [], "data": [], "observability": []}},
  "edges": [{{"from": "<address>", "to": "<address>"}}]}}
Rules:
- Only use addresses that appear in the input "resources". Never invent a resource.
- Put each resource in the single best group among {GROUPS}. Skip resources that do not fit any group.
- "label" is a short human name (4 words max) built from the resource type and name.
- "edges" come only from the input "references" (a resource referencing another one), between known addresses.
- Keep the order of the input. Do not add commentary."""


def call_model(payload: dict) -> str:
    body = {
        "model": os.environ.get("ARCH_MODEL", "claude-haiku-5-5"),
        "max_tokens": 4096,
        "temperature": 0,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": json.dumps(payload, sort_keys=True)}],
    }
    request = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(),
        headers={
            "x-api-key": os.environ["ANTHROPIC_API_KEY"],
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)["content"][0]["text"]


def parse_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    return json.loads(text)


def verify(plan: dict, known: set) -> None:
    errors = []
    if set(plan.get("groups", {})) - set(GROUPS):
        errors.append(f"unknown groups: {sorted(set(plan['groups']) - set(GROUPS))}")
    for group, items in plan.get("groups", {}).items():
        for item in items:
            if item.get("address") not in known:
                errors.append(f"{group}: unknown resource {item.get('address')!r}")
    for edge in plan.get("edges", []):
        for end in ("from", "to"):
            if edge.get(end) not in known:
                errors.append(f"edge: unknown resource {edge.get(end)!r}")
    if errors:
        sys.exit("Diagram rejected, it cites resources absent from the Terraform state:\n  " + "\n  ".join(errors))


def main() -> None:
    source, target = sys.argv[1:3]
    data = json.load(open(source))
    known = {r["address"] for r in data["resources"]}
    if not known:
        sys.exit("No managed resources in the Terraform state")
    if "ANTHROPIC_API_KEY" not in os.environ:
        sys.exit("ANTHROPIC_API_KEY is not set")
    plan = parse_json(call_model(data))
    verify(plan, known)
    json.dump(plan, open(target, "w"), indent=2, sort_keys=True)
    print(f"OK: {sum(len(v) for v in plan['groups'].values())} resources, {len(plan.get('edges', []))} edges")


if __name__ == "__main__":
    main()
