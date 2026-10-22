#!/usr/bin/env python3
"""Deterministically turn the verified plan into a D2 diagram.

usage: render.py <architecture-input.json> <plan.json> <architecture.d2>

Sorted output keeps diffs small between two generations. Resources that the
model left out are added to an "other" group so the diagram stays complete.
"""
import json
import re
import sys

TITLES = {"network": "Network", "compute": "Compute", "data": "Data", "observability": "Observability", "other": "Other"}


def quote(text: str) -> str:
    # Single quotes are literal in D2 (no ${} substitution); '' escapes a quote.
    text = re.sub(r"[\x00-\x1f]", " ", str(text))[:60]
    return "'" + text.replace("'", "''") + "'"


def main() -> None:
    inputs, plan_file, out = sys.argv[1:4]
    resources = {r["address"]: r for r in json.load(open(inputs))["resources"]}
    plan = json.load(open(plan_file))

    placed = {}
    for group, items in plan["groups"].items():
        for item in items:
            placed.setdefault(item["address"], (group, item.get("label") or item["address"]))
    for address, resource in resources.items():
        placed.setdefault(address, ("other", f"{resource['type']} {resource['name']}"))

    node_ids = {address: f"n{i}" for i, address in enumerate(sorted(placed), 1)}
    lines = ["direction: right", ""]
    for group in TITLES:
        members = sorted(a for a, (g, _) in placed.items() if g == group)
        if not members:
            continue
        lines.append(f"{group}: {quote(TITLES[group])} {{")
        for address in members:
            lines.append(f"  {node_ids[address]}: {quote(placed[address][1])}")
        lines.append("}")
        lines.append("")
    edges = sorted({(e["from"], e["to"]) for e in plan.get("edges", []) if e["from"] != e["to"]})
    for source, target in edges:
        lines.append(f"{placed[source][0]}.{node_ids[source]} -> {placed[target][0]}.{node_ids[target]}")
    open(out, "w").write("\n".join(lines).rstrip() + "\n")


if __name__ == "__main__":
    main()
