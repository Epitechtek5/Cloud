# Google Cloud icons

Unmodified copies of the official Google Cloud product icons, used by `../pixel-canvas.d2`.

- Source: the Google Cloud icon library, <https://cloud.google.com/icons> ("Official Google Cloud icons to build your own
  architectural diagrams or reference architectures"). Icon system of 2025, described in
  <https://services.google.com/fh/files/misc/google-cloud-product-icons.pdf> (the legacy 2-tone icons must not be used as of 2026).
- Downloaded on 2026-11-27 from the two stable archives linked on that page:
  - `https://services.google.com/fh/files/misc/core-products-icons.zip` (sha256 `6531a10f58bc599c24d9a455d81dd757c1a03c3c43da9cddf639b859c1c1eece`): `GKE`, `Cloud_Storage`
  - `https://services.google.com/fh/files/misc/category-icons.zip` (sha256 `e5bc3abd3527dc2500e9bff7f15870783e2c764129c49b7cd4c1b4e105345002`): all the other files
- Licence: the page publishes the icons for diagrams and technical documentation but states **no licence text**. They
  stay Google's property and are only used here to illustrate Google Cloud products in the project documentation. Do not
  edit them (recolour, redraw) and do not use them for anything else.

## Why copies and not URLs

The official icons are only published as zip archives, so D2 cannot load them by URL. The third-party URL set of
`icons.terrastruct.com` is not Google's and may be taken down or changed. The few files needed are small
(under 5 KB each), so they are kept in the repository: the diagram renders offline and in CI without a network call.

## Which icon for which product

Since the 2025 icon system, only the core products have their own icon; every other product uses the icon of its
category (the guide above lists the category of each product). Hence the same icon on several boxes: the box label
says which product it is.

| File | Used for |
| --- | --- |
| `GKE-512-color.svg` | GKE (runners cluster) |
| `Cloud_Storage-512-color.svg` | Cloud Storage buckets |
| `ServerlessComputing-512-color.svg` | Cloud Functions (Cloud Run functions) |
| `Databases-512-color.svg` | Firestore |
| `DataAnalytics-512-color.svg` | Pub/Sub |
| `IntegrationServices-512-color.svg` | API Gateway, Eventarc |
| `Networking-512-color-rgb.svg` | VPC, Cloud NAT, Cloud Load Balancing, Cloud CDN |
| `SecurityIdentity-512-color.svg` | Secret Manager, IAM, Workload Identity Federation |
| `Observability-512-color.svg` | Cloud Logging, Monitoring, Trace |
| `DevOps-512-color.svg` | Artifact Registry, Cloud Build |
