import { RetrievedChunk, type RetrievedChunk as TRetrievedChunk } from "@peopleos/schemas";
import type { TxClient } from "../db.js";

/**
 * Module 4 — hybrid retrieval over the org's ACTIVE policy chunks.
 *
 * The spec's Layer-2C index is dense (text-embedding-3-large) + BM25 sparse, with a
 * Pinecone/pgvector ANN store in prod. For DEV we keep it self-contained: load the
 * org's active `DocumentChunk` rows (RLS-scoped via `withTenant`), score each chunk
 * two ways —
 *
 *   • DENSE  : cosine similarity between the query embedding and the chunk's stored
 *              Float[] embedding (brute force in JS), and
 *   • LEXICAL: keyword-overlap between the query terms and the chunk text (a cheap
 *              BM25 stand-in — exact-keyword recall for things like a policy number),
 *
 * then FUSE the two rankings with Reciprocal-Rank Fusion (RRF) and return the top-k as
 * `RetrievedChunk[]`, each carrying the joined PolicyDocument's title / section path /
 * effective date and a score normalised to [0,1]. RRF is order-based, so we never have
 * to reconcile the (incomparable) cosine and overlap magnitudes onto one scale.
 *
 * PROD NOTE: swap `loadActiveChunks` + the in-JS scoring for an ANN query against the
 * vector store (Pinecone namespace `org:doc_type`, hybrid dense+BM25) and a
 * cross-encoder re-rank (spec Module 4 step 2). The fuse + RetrievedChunk shaping below
 * stays identical, so the chat route is insulated from the retrieval backend.
 */

/** RRF damping constant. 60 is the value from the original RRF paper; higher = flatter. */
const RRF_K = 60;

/** A chunk loaded from the DB joined with its parent document's display metadata. */
interface LoadedChunk {
  docId: string;
  docTitle: string;
  sectionPath: string;
  text: string;
  effectiveDate: string | null;
  embedding: number[];
}

/**
 * Cosine similarity of two equal-length dense vectors. Returns 0 for a zero vector or
 * a length mismatch (defensive — a stored embedding from a different model dimension
 * must never crash retrieval, just rank last on the dense axis).
 */
function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Lowercase alphanumeric tokens of length ≥ 2 (drops punctuation + single chars). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Lexical overlap score: the fraction of DISTINCT query terms that appear in the
 * chunk text, lightly weighted by how often they appear (a cheap term-frequency
 * nudge). Bounded so it stays a relative ranking signal, not a magnitude RRF cares
 * about (RRF only uses the rank order this produces).
 */
function lexicalOverlap(queryTerms: ReadonlySet<string>, chunkText: string): number {
  if (queryTerms.size === 0) return 0;
  const counts = new Map<string, number>();
  for (const term of tokenize(chunkText)) {
    if (queryTerms.has(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  if (counts.size === 0) return 0;
  let tf = 0;
  for (const c of counts.values()) tf += 1 + Math.log(c);
  // Coverage of distinct query terms dominates; tf is a small tiebreak.
  return counts.size / queryTerms.size + tf / 1000;
}

/** A descending-sorted ranking → map of chunk-array-index → 1-based rank position. */
function rankPositions(scores: ReadonlyArray<{ index: number; score: number }>): Map<number, number> {
  const ordered = [...scores]
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const positions = new Map<number, number>();
  ordered.forEach((s, i) => positions.set(s.index, i + 1));
  return positions;
}

/**
 * Load the org's ACTIVE policy chunks joined with their document's display metadata.
 * MUST be called with a `tx` from `withTenant(orgId, …)` so RLS scopes it to the org;
 * we still filter on `orgId` + `active` explicitly as defence-in-depth and to use the
 * (orgId, docId, active) index. Superseded/archived chunks have `active=false` and are
 * therefore never retrievable (Layer 2C step 5).
 */
async function loadActiveChunks(tx: TxClient, orgId: string): Promise<LoadedChunk[]> {
  const rows = await tx.documentChunk.findMany({
    // Defence-in-depth: also require the parent document to be ACTIVE, so a doc flipped
    // to SUPERSEDED/ARCHIVED can never surface even if a chunk's `active` flag is stale.
    where: { orgId, active: true, doc: { status: "ACTIVE" } },
    select: {
      docId: true,
      sectionPath: true,
      text: true,
      embedding: true,
      doc: { select: { title: true, effectiveDate: true } },
    },
  });

  return rows.map((row) => ({
    docId: row.docId,
    docTitle: row.doc.title,
    sectionPath: row.sectionPath,
    text: row.text,
    effectiveDate: row.doc.effectiveDate ? row.doc.effectiveDate.toISOString().slice(0, 10) : null,
    embedding: row.embedding,
  }));
}

/**
 * Hybrid retrieve the top-`k` policy chunks for a query, fusing dense cosine and
 * lexical overlap via Reciprocal-Rank Fusion. Returns `RetrievedChunk[]` (validated
 * against the frozen contract) ordered best-first, with `score` normalised to [0,1]
 * by dividing each fused RRF score by the maximum fused score in the result set.
 *
 * `queryEmbedding` is the dense vector from `aiClient.embed`; `queryText` drives the
 * lexical axis. If the org has no active chunks, returns `[]` (the chat route turns an
 * empty/low-signal retrieval into a grounded "I don't have that in policy" + escalate).
 */
export async function retrieveChunks(
  tx: TxClient,
  orgId: string,
  queryEmbedding: readonly number[],
  queryText: string,
  k: number,
): Promise<TRetrievedChunk[]> {
  const chunks = await loadActiveChunks(tx, orgId);
  if (chunks.length === 0) return [];

  const queryTerms = new Set(tokenize(queryText));

  // Score each chunk on both axes (paired with its array index for fusion).
  const denseScores = chunks.map((c, index) => ({ index, score: cosine(queryEmbedding, c.embedding) }));
  const lexicalScores = chunks.map((c, index) => ({ index, score: lexicalOverlap(queryTerms, c.text) }));

  const denseRanks = rankPositions(denseScores);
  const lexicalRanks = rankPositions(lexicalScores);

  // Reciprocal-Rank Fusion: a chunk's fused score is the sum over the two rankings of
  // 1/(RRF_K + rank). A chunk absent from a ranking (score 0 there) contributes 0 from
  // that axis. This rewards chunks that rank well on EITHER signal without needing the
  // dense/lexical magnitudes to be comparable.
  const fused = chunks
    .map((_, index) => {
      const dr = denseRanks.get(index);
      const lr = lexicalRanks.get(index);
      const score =
        (dr ? 1 / (RRF_K + dr) : 0) + (lr ? 1 / (RRF_K + lr) : 0);
      return { index, score };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, k));

  if (fused.length === 0) return [];

  // Normalise to [0,1] against the best fused score so `score` satisfies UnitScore and
  // gives the AI service a comparable per-chunk confidence signal.
  const maxScore = fused[0]?.score ?? 1;

  return fused.map((f) => {
    const c = chunks[f.index];
    if (!c) throw new Error("retrieveChunks: fused index out of range");
    return RetrievedChunk.parse({
      docId: c.docId,
      docTitle: c.docTitle,
      sectionPath: c.sectionPath,
      text: c.text,
      effectiveDate: c.effectiveDate,
      score: maxScore > 0 ? Math.min(1, f.score / maxScore) : 0,
    });
  });
}
