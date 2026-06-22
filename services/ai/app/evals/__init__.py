"""Evaluation harness for Module 1 (spec Layer 6: Precision@k, tier accuracy).

Runnable offline (the ranker's deterministic fallbacks cover the LLM/embedding
steps), so the eval gate can run in CI without network (prompt standard #6).
"""
