# Security V2

**Status:** Extends `docs/SECURITY.md` for the OS vision.

Additional requirements:

- Agent capability permissions ≠ human admin blast radius  
- Tool risk levels + SSRF-safe fetch  
- Prompt injection defence (untrusted web/social/docs)  
- Tool output treated as data  
- PII-aware logging; retention/deletion for GDPR  
- Entitlement-aware access  
- Outbox/idempotency for consequential actions  

Production schema changes: `migrate deploy` only.
