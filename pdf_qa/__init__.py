"""pdf_qa — multimodal Retrieval-Augmented Q&A over a PDF library.

Pipeline (Option B, multimodal):
  ingest:  PDF -> per-page image + text -> chunks -> OpenAI text embeddings -> local store
  ask:     question -> retrieve text chunks -> gather their page images -> GPT-4o vision answer

Only TEXT is embedded at ingest time (cheap). Page IMAGES are sent to the
vision model only for the handful of pages retrieved at query time, so the
model can actually read charts, schematics and equations to answer.
"""

__version__ = "0.1.0"
