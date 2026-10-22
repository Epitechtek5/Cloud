# Reduces `terraform show -json` outputs (one file per stack) to the minimum
# needed for the diagram: addresses, types, names and references. Attribute
# values are never kept, since they can hold sensitive data.
{
  resources: [
    .[] | .values.root_module? // empty
    | recurse(.child_modules[]?)
    | .resources[]?
    | select(.mode == "managed")
    | {address, type, name}
  ] | unique_by(.address),
  references: [
    .[] | .configuration.root_module? // empty
    | recurse(.module_calls[]?.module)
    | .resources[]?
    | {address, references: ([.. | .references? // empty | .[]] | unique)}
  ]
}
