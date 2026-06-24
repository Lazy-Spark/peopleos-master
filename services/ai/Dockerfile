# syntax=docker/dockerfile:1
# PeopleOS AI service (FastAPI + LangGraph) — PHASE 2, only needed for AI features
# (the Agentic Assistant, resume ranking, etc.). The core ATS UI works without it.
#
# Build context = services/ai (on Railway set this service's Root Directory to
# "services/ai"). Requires ANTHROPIC_API_KEY + OPENAI_API_KEY at runtime; without the
# Node API reachable at PEOPLEOS_API_URL + a shared AI_SERVICE_SECRET, the agent's tools
# degrade gracefully (it still runs, but can't fetch tool data).
FROM python:3.11-slim
WORKDIR /app

# Base dependencies only (the heavy [parsers]/[transcription]/ML extras are optional and
# the service degrades gracefully without them — see pyproject.toml).
COPY pyproject.toml README.md ./
COPY app app
RUN pip install --no-cache-dir .

ENV PEOPLEOS_API_URL=http://localhost:3001
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
