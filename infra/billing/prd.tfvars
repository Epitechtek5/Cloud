project_id  = "huiledecloud-cloudnative-prd"
environment = "prd"

# Monthly budget in the billing account currency, credits excluded (gross cost).
# Thresholds: default of budget_thresholds (50, 90, 100 % actual, 100 % forecasted).
budget_amount = 50

# billing_account and notification_emails: in prd.local.tfvars (not committed),
# see local.tfvars.example.
