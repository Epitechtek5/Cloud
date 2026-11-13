# What the two pipeline identities may do. Every role is listed with the reason
# it is needed; see README.md for the review of each one.

locals {
  deploy_member = "serviceAccount:${google_service_account.deploy.email}"
  plan_member   = "serviceAccount:${google_service_account.plan.email}"

  # Project-level roles of gha-deploy, one per resource family of the
  # foundation and serverless stacks, in place of roles/editor (which carries
  # iam.serviceAccountKeys.create). None of them can create a key, mint a token
  # or set the project IAM policy. A stack using a new resource type needs its
  # role here first. See README.md "Roles".
  deploy_project_roles = {
    "roles/viewer"                         = "refresh: read every resource and policy of the stacks"
    "roles/serviceusage.serviceUsageAdmin" = "google_project_service of every stack"
    "roles/compute.networkAdmin"           = "VPC, subnets, router, NAT, global address, load balancer (url maps, proxies, forwarding rules, backend bucket)"
    "roles/compute.securityAdmin"          = "firewall rules, SSL policy and managed certificate of the load balancer"
    "roles/container.clusterAdmin"         = "GKE runners cluster and node pool"
    "roles/container.developer"            = "Kubernetes objects of the runners charts (namespaces, deployments, CRDs, config maps, network policies)"
    "roles/iam.serviceAccountAdmin"        = "one service account per function and node pool"
    "roles/iam.serviceAccountUser"         = "actAs: run the node pool and the functions as their own service accounts"
    "roles/cloudfunctions.developer"       = "Cloud Functions (2nd gen)"
    "roles/artifactregistry.admin"         = "Artifact Registry repository of the functions"
    "roles/secretmanager.admin"            = "Secret Manager secrets (containers only, values are added by hand)"
    "roles/storage.admin"                  = "buckets (frontend, function sources, data) and their objects"
    "roles/pubsub.editor"                  = "Pub/Sub topics, subscriptions and dead-letter topics"
    "roles/datastore.owner"                = "Firestore database, indexes and fields"
    "roles/apigateway.admin"               = "API Gateway: API, config and gateway (no key, impersonation or project IAM)"
    "roles/firebaserules.admin"            = "Firestore security rules (ruleset and release)"
  }

  # Project-level roles of gha-plan. Nothing here can change a resource.
  plan_project_roles = {
    "roles/viewer"               = "refresh every resource of the stacks"
    "roles/iam.securityReviewer" = "read the IAM policies of the resources (*_iam_member refresh)"
    "roles/firebaserules.viewer" = "read the Firestore security rules (roles/viewer does not)"
  }

  # Project roles gha-deploy may grant or revoke, and nothing else, so it can
  # never grant itself roles/owner. A stack binding a new project-level role
  # needs it added here and this stack applied first, or its apply gets a 403.
  # Never add roles/owner, roles/editor, a roles/*Admin role or
  # roles/iam.serviceAccountTokenCreator (at project level it impersonates
  # every service account).
  deploy_grantable_roles = [
    "roles/container.defaultNodeServiceAccount", # foundation: runner nodes
    "roles/logging.logWriter",                   # every function, build account
    "roles/monitoring.metricWriter",             # functions, OpenTelemetry metrics
    "roles/cloudtrace.agent",                    # every function
    "roles/storage.objectViewer",                # build account (with a condition)
    "roles/datastore.user",                      # Firestore writers (workers)
    "roles/datastore.viewer",                    # Firestore readers
    "roles/eventarc.eventReceiver",              # Eventarc triggers
  ]

  # Resource-level IAM the stacks manage (one service account per function,
  # secrets, buckets, topics, Cloud Run invokers). It only reaches the resource
  # itself, so it cannot be used to escalate at project level.
  deploy_iam_permissions = [
    "artifactregistry.repositories.getIamPolicy",
    "artifactregistry.repositories.setIamPolicy",
    "iam.serviceAccounts.getIamPolicy",
    "iam.serviceAccounts.setIamPolicy",
    "pubsub.subscriptions.getIamPolicy",
    "pubsub.subscriptions.setIamPolicy",
    "pubsub.topics.getIamPolicy",
    "pubsub.topics.setIamPolicy",
    "run.services.getIamPolicy",
    "run.services.setIamPolicy",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.setIamPolicy",
    "storage.buckets.getIamPolicy",
    "storage.buckets.setIamPolicy",
  ]

  # Kubernetes RBAC objects created by the ARC Helm charts in the runners
  # cluster. On GKE roles/editor stops short of these, and
  # roles/container.admin would also bring impersonation, token creation and
  # CSR approval. bind/escalate let a chart bind a role with more rights than
  # roles/editor gives (docs/ci/self-hosted-runners.md).
  deploy_k8s_permissions = [
    "container.clusterRoleBindings.create",
    "container.clusterRoleBindings.delete",
    "container.clusterRoleBindings.update",
    "container.clusterRoles.bind",
    "container.clusterRoles.create",
    "container.clusterRoles.delete",
    "container.clusterRoles.escalate",
    "container.clusterRoles.update",
    "container.roleBindings.create",
    "container.roleBindings.delete",
    "container.roleBindings.update",
    "container.roles.bind",
    "container.roles.create",
    "container.roles.delete",
    "container.roles.escalate",
    "container.roles.update",
  ]
}

# --- gha-deploy ---------------------------------------------------------------

resource "google_project_iam_member" "deploy" {
  #checkov:skip=CKV_GCP_41:actAs is needed to run the node pool and the functions as their own accounts, which the stacks create (not known here); token creation is not granted
  #checkov:skip=CKV_GCP_42:The deploy account creates and destroys the resources: per-service admin roles replace roles/editor, none of them holds key creation or the project IAM policy
  #checkov:skip=CKV_GCP_49:serviceAccountAdmin and serviceAccountUser cover the accounts the stacks create; no token creator, key admin or workload identity role at project level
  #checkov:skip=CKV_GCP_117:roles/viewer is read-only and lets Terraform refresh every resource; roles/editor and roles/owner are not granted
  for_each = local.deploy_project_roles

  project = var.project_id
  role    = each.key
  member  = local.deploy_member
}

# roles/editor cannot set any IAM policy. projectIamAdmin can, so it is limited
# by a condition to the roles of deploy_grantable_roles. Outside setIamPolicy
# the attribute is empty, so reading the policy stays allowed.
resource "google_project_iam_member" "deploy_grantable" {
  #checkov:skip=CKV_GCP_42:projectIamAdmin is limited by the condition to the roles of deploy_grantable_roles, none of them an admin role
  project = var.project_id
  role    = "roles/resourcemanager.projectIamAdmin"
  member  = local.deploy_member

  condition {
    title       = "grantable-roles-only"
    description = "Deploy pipeline may only grant the roles listed in infra/access/roles.tf"
    expression  = "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([${join(", ", formatlist("'%s'", local.deploy_grantable_roles))}])"
  }
}

resource "google_project_iam_custom_role" "deploy_iam_bindings" {
  project     = var.project_id
  role_id     = "ghaDeployIamBindings"
  title       = "GitHub deploy: resource IAM bindings"
  description = "IAM policies of the resources managed by the Terraform stacks (infra/access)"
  permissions = local.deploy_iam_permissions
  stage       = "GA"
}

resource "google_project_iam_member" "deploy_iam_bindings" {
  project = var.project_id
  role    = google_project_iam_custom_role.deploy_iam_bindings.name
  member  = local.deploy_member
}

# Two of these permissions are at the TESTING support level for custom roles:
# the API accepts them with a warning.
resource "google_project_iam_custom_role" "deploy_k8s_rbac" {
  project     = var.project_id
  role_id     = "ghaDeployK8sRbac"
  title       = "GitHub deploy: Kubernetes RBAC"
  description = "Roles and bindings created by the Helm charts of the GKE clusters (infra/access)"
  permissions = local.deploy_k8s_permissions
  stage       = "GA"
}

resource "google_project_iam_member" "deploy_k8s_rbac" {
  project = var.project_id
  role    = google_project_iam_custom_role.deploy_k8s_rbac.name
  member  = local.deploy_member
}

# Read and write the Terraform states (and their locks).
resource "google_storage_bucket_iam_member" "deploy_state" {
  bucket = var.state_bucket
  role   = "roles/storage.objectAdmin"
  member = local.deploy_member
}

# --- gha-plan -----------------------------------------------------------------

resource "google_project_iam_member" "plan" {
  #checkov:skip=CKV_GCP_117:roles/viewer is the read-only role the PR plan needs to refresh every resource of the stacks
  for_each = local.plan_project_roles

  project = var.project_id
  role    = each.key
  member  = local.plan_member
}

resource "google_storage_bucket_iam_member" "plan_state" {
  bucket = var.state_bucket
  role   = "roles/storage.objectViewer"
  member = local.plan_member
}

# `terraform init` writes a .tflock object even for a plan: writes are allowed
# on the lock files only, never on a state.
resource "google_storage_bucket_iam_member" "plan_state_locks" {
  bucket = var.state_bucket
  role   = "roles/storage.objectUser"
  member = local.plan_member

  condition {
    title      = "plan-lock-files"
    expression = "resource.name.endsWith('.tflock')"
  }
}
