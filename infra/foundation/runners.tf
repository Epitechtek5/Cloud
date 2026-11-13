# Self-hosted GitHub Actions runners on the runners cluster (gke.tf), with
# Actions Runner Controller (ARC, runner scale sets). Everything that used to be
# applied by hand (namespaces, LimitRange, NetworkPolicy, Helm releases) is
# here, so a release deploys it and a destroy removes it.
#
# Order, enforced by the references and depends_on below:
#   cluster + node pool + NAT -> namespaces, LimitRange, NetworkPolicy
#   -> controller -> scale set
# A destroy walks it backwards: the scale set is uninstalled while the
# controller, the nodes and the NAT still exist, so the controller removes the
# scale set registration from GitHub (finalizer) before it goes away itself.
#
# Not managed here: the GitHub App secret (see docs/ci/self-hosted-runners.md).

locals {
  arc_chart_repository = "oci://ghcr.io/actions/actions-runner-controller-charts"
  arc_namespace        = "arc-systems"
  runners_namespace    = "arc-runners"
  # Fixed so that the scale set can point to it: with watchSingleNamespace the
  # scale set chart cannot discover the controller by itself.
  arc_controller_service_account = "arc-gha-rs-controller"
  # Kubernetes Secret holding the GitHub App id, installation id and private
  # key, created out of band in the runners namespace.
  arc_github_secret = "arc-github-app"
  runners_values    = "${path.module}/../../k8s/runners"

  runners_namespaces = var.runners_enabled ? toset([local.arc_namespace, local.runners_namespace]) : toset([])
}

resource "kubernetes_namespace_v1" "runners" {
  for_each = local.runners_namespaces

  metadata {
    name = each.value
  }

  # The node pool and the NAT must outlive the namespaces on destroy: the
  # controller runs there and needs GitHub to clean up the registration.
  depends_on = [google_container_node_pool.runners, google_compute_router_nat.runners]
}

# The dind sidecar injected by the scale set chart has no resources, so the
# scheduler would ignore the load of docker builds and job containers and
# overcommit the node (evicting the ARC controller or listener). Containers
# that declare nothing get these defaults; the runner container sets its own.
resource "kubernetes_limit_range_v1" "runners" {
  count = var.runners_enabled ? 1 : 0

  metadata {
    name      = "runners-defaults"
    namespace = kubernetes_namespace_v1.runners[local.runners_namespace].metadata[0].name
  }

  spec {
    limit {
      type = "Container"
      default_request = {
        cpu    = "500m"
        memory = "1Gi"
      }
      default = {
        cpu    = "2"
        memory = "4Gi"
      }
    }
  }
}

# Runner pods may reach the internet (GitHub, package registries) but not the
# cluster internals: no traffic to other pods or to the private ranges.
resource "kubernetes_network_policy_v1" "runners_egress" {
  count = var.runners_enabled ? 1 : 0

  metadata {
    name      = "runners-egress-internet-only"
    namespace = kubernetes_namespace_v1.runners[local.runners_namespace].metadata[0].name
  }

  spec {
    pod_selector {}
    policy_types = ["Egress"]

    # DNS
    egress {
      to {
        namespace_selector {
          match_labels = { "kubernetes.io/metadata.name" = "kube-system" }
        }
      }
      ports {
        protocol = "UDP"
        port     = "53"
      }
      ports {
        protocol = "TCP"
        port     = "53"
      }
    }

    # Everything public, nothing private
    egress {
      to {
        ip_block {
          cidr = "0.0.0.0/0"
          except = [
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "169.254.0.0/16",
          ]
        }
      }
    }
  }
}

# Nothing may connect to a runner pod: they only open outgoing connections.
resource "kubernetes_network_policy_v1" "runners_deny_ingress" {
  count = var.runners_enabled ? 1 : 0

  metadata {
    name      = "runners-deny-ingress"
    namespace = kubernetes_namespace_v1.runners[local.runners_namespace].metadata[0].name
  }

  spec {
    pod_selector {}
    policy_types = ["Ingress"]
  }
}

# Watches the scale sets and creates the ephemeral runner pods. One per cluster.
resource "helm_release" "arc_controller" {
  count = var.runners_enabled ? 1 : 0

  name       = "arc"
  namespace  = kubernetes_namespace_v1.runners[local.arc_namespace].metadata[0].name
  repository = local.arc_chart_repository
  chart      = "gha-runner-scale-set-controller"
  version    = var.runners_arc_version

  values = [
    file("${local.runners_values}/controller-values.yaml"),
    yamlencode({
      serviceAccount = { name = local.arc_controller_service_account }
      # The controller only manages the scale sets of the runners namespace.
      flags = { watchSingleNamespace = local.runners_namespace }
    }),
  ]

  # Waits for the controller to be ready on install, and for its resources to
  # be gone on uninstall.
  wait    = true
  timeout = 600
}

# One pool of ephemeral runners: one job per pod, deleted when the job ends.
# Its name is the label to put in runs-on / CI_RUNNER.
resource "helm_release" "arc_runner_set" {
  count = var.runners_enabled ? 1 : 0

  name       = var.runners_cluster_name
  namespace  = kubernetes_namespace_v1.runners[local.runners_namespace].metadata[0].name
  repository = local.arc_chart_repository
  chart      = "gha-runner-scale-set"
  version    = var.runners_arc_version

  values = [
    file("${local.runners_values}/runner-set-values.yaml"),
    yamlencode({
      runnerScaleSetName = var.runners_cluster_name
      githubConfigSecret = local.arc_github_secret
      minRunners         = var.runners_min_runners
      maxRunners         = var.runners_max_runners
      controllerServiceAccount = {
        namespace = local.arc_namespace
        name      = local.arc_controller_service_account
      }
    }),
  ]

  wait    = true
  timeout = 600

  # The controller must be running (it reconciles the scale set and removes it
  # from GitHub on uninstall), and the runner pods must never start without
  # their LimitRange and NetworkPolicy.
  depends_on = [
    helm_release.arc_controller,
    kubernetes_limit_range_v1.runners,
    kubernetes_network_policy_v1.runners_egress,
    kubernetes_network_policy_v1.runners_deny_ingress,
  ]
}
