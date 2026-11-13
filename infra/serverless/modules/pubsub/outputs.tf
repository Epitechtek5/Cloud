output "topics" {
  description = "Topic ids by channel name"
  value       = { for k, t in google_pubsub_topic.main : k => t.id }
}

output "topic_names" {
  description = "Topic short names by channel name (for the PUBSUB_TOPIC environment variable of proxies)"
  value       = { for k, t in google_pubsub_topic.main : k => t.name }
}

output "subscriptions" {
  description = "Consumer subscription ids by channel name"
  value       = { for k, s in google_pubsub_subscription.main : k => s.id }
}

output "dlq_topics" {
  description = "Dead-letter topic ids by channel name"
  value       = { for k, t in google_pubsub_topic.dlq : k => t.id }
}

output "dlq_subscriptions" {
  description = "Dead-letter pull subscription ids by channel name"
  value       = { for k, s in google_pubsub_subscription.dlq : k => s.id }
}
