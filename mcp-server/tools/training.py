"""
Training data collection tools (Section K).

MCP tools for capturing user questions, generating hypotheses,
evaluating them against actual results, and storing training data.
"""

from __future__ import annotations

import os
import json
import logging
from typing import Optional

_log = logging.getLogger("geocluster.training")


def _capture_disabled() -> Optional[dict]:
    """Return a disabled-status response when TRAINING_CAPTURE_ENABLED != '1'.

    Returning None means capture is enabled; the caller should proceed.
    """
    if os.environ.get("TRAINING_CAPTURE_ENABLED", "1") != "1":
        return {"status": "disabled", "reason": "TRAINING_CAPTURE_ENABLED != '1'"}
    return None

from .config import resolve_path, WORKSPACE_ROOT

# Import training module components
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from training.session import TrainingSession, get_session_manager
from training.evaluator import (
    HypothesisEvaluator,
    StructuredHypothesis,
    ClaimType,
    parse_hypothesis_response,
)
from training.storage import TrainingDataStorage


# Environment variables for the optional training-capture LLM endpoint.
# Unset (the default) disables the training tools.
TRAINING_LLM_PROXY_URL = os.environ.get("TRAINING_LLM_PROXY_URL", "")
TRAINING_LLM_TOKEN = os.environ.get("TRAINING_LLM_TOKEN", "")
TRAINING_MODEL = os.environ.get("TRAINING_MODEL", "anthropic/claude-3-haiku")


HYPOTHESIS_SYSTEM_PROMPT = """You are a geological data analyst generating MECHANICALLY GRADABLE hypotheses.

Given a user's question and the code/operations that will be executed, predict what the results will show.

Output EXACTLY 10 hypotheses as a JSON array. Each hypothesis is a JSON object.

# Required fields (every hypothesis)
- "text": A clear, specific prediction (string)
- "claim_type": One of: "correlation", "distribution", "cluster", "anomaly", "comparison", "existence", "count", "trend", "general"
- "reasoning": Brief geological reasoning (string)

# Optional reference fields
- "column_a", "column_b": Column names if applicable (string or null)
- "direction": "positive", "negative", or "none" (string or null) — required for correlation/trend

# Numeric constraint fields — AT LEAST ONE MUST BE SET PER HYPOTHESIS
A hypothesis without a numeric constraint cannot be graded and is discarded as training-useless.
- "count_range": [low, high] (2 integers) — for counting things
- "expected_count": single integer — for exact count claims
- "value_range": [low, high] (2 numbers) — for value/magnitude/proportion claims
- "magnitude_range": [low, high] (2 numbers) — for correlation r values, scores
- "threshold": single number — for existence claims with cutoffs
- "cluster_id": integer — for claims about a specific cluster

# Required field PER claim_type — pick the matching constraint
| claim_type   | required constraint                                                          |
|--------------|-------------------------------------------------------------------------------|
| count        | count_range OR expected_count                                                 |
| distribution | value_range (for mean/percentile/proportion of a column)                     |
| correlation  | magnitude_range AND direction                                                 |
| cluster      | count_range (cluster count) OR cluster_id+value_range (per-cluster size)     |
| anomaly      | count_range OR expected_count (number of anomalies/outliers)                 |
| existence    | column_a AND threshold (e.g., "values above threshold exist")                |
| comparison   | value_range (the difference or ratio between A and B)                        |
| trend        | magnitude_range AND direction (slope of trend)                               |
| general      | avoid this claim_type — too vague to grade                                   |

# Critical rules
1. **Extract numbers from the question.** If the user said "29489 rows" or "3 clusters", emit count_range:[29489,29489] or expected_count:3 — exact values, not vague ranges.
2. **Use the RIGHT field for the claim_type.** A "count" claim with value_range and no count_range will be discarded.
3. **Be specific.** Wide ranges score lower than narrow ones. "magnitude_range:[0.4,0.6]" beats "[-1,1]".
4. **Don't assume domain context.** If the question doesn't mention porphyry/epithermal/skarn/etc., don't anchor your hypotheses on a specific deposit type. Predict from the data shape, not from a prior.
5. **Match the actual analysis.** If the operations include `cluster(k=3)`, hypothesize about 3 clusters. If they include `query_data(operation='value_counts')`, hypothesize about category counts.

# Example outputs (covering several claim_types)
# Note: examples rotate across different columns/claim types on purpose — do NOT infer
# that Au/Cu or any single element should dominate your hypotheses.

[
  {
    "text": "The dataset contains 29489 rows after parsing detection limits.",
    "claim_type": "count",
    "column_a": null,
    "expected_count": 29489,
    "reasoning": "User question specifies 29489 rows; verify_claims should confirm exact match."
  },
  {
    "text": "K-means with k=3 produces 3 clusters, with the largest containing 60-75% of samples.",
    "claim_type": "cluster",
    "column_a": null,
    "count_range": [3, 3],
    "value_range": [0.60, 0.75],
    "reasoning": "High-dimensional numerical data often produces one large cluster and a few smaller ones under default scaling."
  },
  {
    "text": "Mean Cu_ppm across the dataset falls between 20 and 500 ppm.",
    "claim_type": "distribution",
    "column_a": "Cu_ppm",
    "value_range": [20, 500],
    "reasoning": "Typical exploration-dataset backgrounds are in the tens to low hundreds of ppm; the mean is sensitive to a small number of anomaly samples."
  },
  {
    "text": "Silhouette score of the k=3 clustering is between 0.3 and 0.6.",
    "claim_type": "distribution",
    "column_a": "silhouette",
    "value_range": [0.3, 0.6],
    "reasoning": "Real-world numerical clusters on mixed-unit features usually show moderate rather than crisp separation."
  },
  {
    "text": "Outlier count (>3 sigma) in Zn_ppm is between 100 and 600.",
    "claim_type": "anomaly",
    "column_a": "Zn_ppm",
    "count_range": [100, 600],
    "reasoning": "Heavy-tailed numerical distributions typically show a small fraction of high-side tail values beyond 3 sigma."
  },
  {
    "text": "The lithology column contains between 3 and 12 distinct rock-type categories.",
    "claim_type": "count",
    "column_a": "lithology",
    "count_range": [3, 12],
    "reasoning": "Typical drill-hole datasets log a moderate number of rock types per project."
  }
]"""


def start_training_session(
    question: str,
    specialist_type: str = None,
) -> dict:
    """
    Start a training data collection session.
    
    Call this at the beginning of an analysis workflow to capture
    the user's question and subsequent tool calls for training data.
    
    Args:
        question: The user's original question being answered
        specialist_type: Optional specialist type (dataops, analytics, etc.)

    Returns:
        Session info including session_id for subsequent calls
    """
    disabled = _capture_disabled()
    if disabled:
        return disabled

    manager = get_session_manager()
    
    session = manager.start_session(
        question=question,
        specialist_type=specialist_type,
    )
    
    return {
        "status": "started",
        "session_id": session.session_id,
        "message": f"Training session started. Tool calls will be recorded.",
        "question": question,
    }


def generate_hypotheses(
    session_id: str,
    num_hypotheses: int = 10,
) -> dict:
    """
    Generate hypotheses about the analysis output.
    
    Uses an LLM to predict what the results will show, based on
    the question and code executed (without seeing actual results).
    
    Args:
        session_id: The training session ID from start_training_session
        num_hypotheses: Number of hypotheses to generate (default 10)
    
    Returns:
        List of structured hypotheses
    """
    disabled = _capture_disabled()
    if disabled:
        return disabled

    manager = get_session_manager()
    session = manager.get_session(session_id)

    if not session:
        return {"error": f"Session {session_id} not found"}

    if not session.tool_calls:
        return {"error": "No tool calls recorded yet. Run analysis first."}
    
    # Build the prompt (code without results)
    code_context = session.get_code_context(include_results=False)
    
    user_prompt = f"""**Question:** {session.question}

**Operations to be executed:**
```python
{code_context}
```

Generate exactly {num_hypotheses} specific, testable hypotheses about what the results will show.
Output as a JSON array."""

    # Call LLM
    hypotheses_response = _call_llm(
        system_prompt=HYPOTHESIS_SYSTEM_PROMPT,
        user_prompt=user_prompt,
    )
    
    if "error" in hypotheses_response:
        return hypotheses_response
    
    # Parse response into structured hypotheses
    response_text = hypotheses_response.get("content", "")
    hypotheses = parse_hypothesis_response(response_text)
    
    if not hypotheses:
        return {
            "error": "Failed to parse hypotheses from LLM response",
            "raw_response": response_text[:1000],
        }
    
    # Store hypotheses in session
    session.hypotheses = [h.to_dict() for h in hypotheses]
    
    return {
        "status": "success",
        "session_id": session_id,
        "hypotheses_count": len(hypotheses),
        "hypotheses": [h.to_dict() for h in hypotheses],
    }


def evaluate_hypotheses(
    session_id: str,
    source_data_path: str = None,
) -> dict:
    """
    Evaluate hypotheses against actual results.
    
    Compares each hypothesis to the actual output from tool execution,
    determining correctness and computing specificity scores.
    
    Args:
        session_id: The training session ID
        source_data_path: Optional path to source data for additional checks
    
    Returns:
        Evaluation results with correct/incorrect hypotheses
    """
    disabled = _capture_disabled()
    if disabled:
        return disabled

    try:
        manager = get_session_manager()
        session = manager.get_session(session_id)

        if not session:
            return {"error": f"Session {session_id} not found"}

        if not session.hypotheses:
            return {"error": "No hypotheses generated yet. Call generate_hypotheses first."}

        # A2: pass the full tool-call trace so evaluators can find data in any
        # call's result, not just the last one. Earlier design assumed the last
        # call was always "the answer" — false for multi-tool workflows like
        # dataops which run inspect_dataset + query_data + validate_geology + ...
        if not session.tool_calls:
            return {"error": "No tool calls recorded; nothing to evaluate against"}

        # Convert stored dicts back to StructuredHypothesis objects
        hypotheses = [StructuredHypothesis.from_dict(h) for h in session.hypotheses]

        # Load source data if provided
        source_data = None
        if source_data_path:
            try:
                from .dataframe_cache import load
                source_data = load(source_data_path)
            except Exception:
                pass  # Continue without source data

        # Evaluate against the full tool-call trace
        evaluator = HypothesisEvaluator(tolerance=0.1)
        evaluated = evaluator.evaluate_batch(hypotheses, session.tool_calls, source_data)
    except Exception as exc:
        # Last-resort catch: anything unhandled inside the evaluator path returns a
        # structured JSON error. Without this, FastMCP serialized the exception as
        # a plain text response that broke client-side JSON parsing — the V1 bug.
        _log.exception("evaluate_hypotheses crashed for session %s", session_id)
        return {
            "error": f"evaluator crashed: {type(exc).__name__}: {exc}",
            "session_id": session_id,
        }
    
    # Categorize results
    correct = [h for h in evaluated if h.is_correct is True]
    incorrect = [h for h in evaluated if h.is_correct is False]
    unevaluated = [h for h in evaluated if h.is_correct is None]
    
    # Store evaluation results
    session.evaluation_results = {
        "correct_count": len(correct),
        "incorrect_count": len(incorrect),
        "unevaluated_count": len(unevaluated),
        "evaluated_hypotheses": [h.to_dict() for h in evaluated],
    }
    
    return {
        "status": "success",
        "session_id": session_id,
        "correct": [h.to_dict() for h in correct],
        "incorrect": [h.to_dict() for h in incorrect],
        "unevaluated": [h.to_dict() for h in unevaluated],
        "summary": {
            "correct_count": len(correct),
            "incorrect_count": len(incorrect),
            "unevaluated_count": len(unevaluated),
            "avg_specificity_correct": (
                sum(h.specificity_score for h in correct) / len(correct)
                if correct else 0
            ),
            "avg_specificity_incorrect": (
                sum(h.specificity_score for h in incorrect) / len(incorrect)
                if incorrect else 0
            ),
        },
    }


def end_training_session(
    session_id: str,
    save: bool = True,
) -> dict:
    """
    End a training session and optionally save the data.
    
    Finalizes the session, saves correct hypotheses for SFT training,
    and saves rejected hypotheses for reference.
    
    Args:
        session_id: The training session ID
        save: Whether to save the training data (default True)
    
    Returns:
        Summary of saved data
    """
    disabled = _capture_disabled()
    if disabled:
        return disabled

    manager = get_session_manager()
    session = manager.get_session(session_id)

    if not session:
        return {"error": f"Session {session_id} not found"}

    if not session.evaluation_results:
        return {"error": "No evaluation results. Call evaluate_hypotheses first."}
    
    result = {
        "status": "ended",
        "session_id": session_id,
    }
    
    if save:
        # Get evaluated hypotheses
        evaluated_dicts = session.evaluation_results.get("evaluated_hypotheses", [])
        hypotheses = [StructuredHypothesis.from_dict(h) for h in evaluated_dicts]
        
        # Save to storage
        storage = TrainingDataStorage()
        save_result = storage.save_session(session, hypotheses)
        result.update(save_result)
        result["status"] = "saved"
    
    # Mark session as finalized and remove from active tracking
    session.finalized = True
    manager.end_session(session_id)

    eval_results = session.evaluation_results or {}
    _log.info(
        "training_session_end session_id=%s tool_calls=%d hypotheses=%d "
        "correct=%d incorrect=%d unevaluated=%d saved=%s",
        session_id,
        len(session.tool_calls),
        len(session.hypotheses),
        eval_results.get("correct_count", 0),
        eval_results.get("incorrect_count", 0),
        eval_results.get("unevaluated_count", 0),
        bool(save),
    )

    return result


def get_training_stats() -> dict:
    """
    Get statistics about collected training data.
    
    Returns:
        Summary of training data collected so far
    """
    storage = TrainingDataStorage()
    return storage.get_stats()


def _call_llm(system_prompt: str, user_prompt: str) -> dict:
    """
    Call the training LLM proxy.
    
    Uses TRAINING_LLM_PROXY_URL and TRAINING_LLM_TOKEN.
    """
    import httpx
    
    if not TRAINING_LLM_PROXY_URL:
        return {"error": "TRAINING_LLM_PROXY_URL not configured"}
    
    if not TRAINING_LLM_TOKEN:
        return {"error": "TRAINING_LLM_TOKEN not configured"}
    
    try:
        with httpx.Client(timeout=60.0) as client:
            response = client.post(
                f"{TRAINING_LLM_PROXY_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {TRAINING_LLM_TOKEN}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": TRAINING_MODEL,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "temperature": 0.7,
                    "max_tokens": 4000,
                },
            )
            
            if response.status_code != 200:
                return {
                    "error": f"LLM request failed: {response.status_code}",
                    "detail": response.text[:500],
                }
            
            data = response.json()
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            
            return {"content": content}
    
    except httpx.TimeoutException:
        return {"error": "LLM request timed out"}
    except Exception as e:
        return {"error": f"LLM request failed: {str(e)}"}


def record_tool_call(tool: str, args: dict, result) -> bool:
    """
    Record a tool call to the active training session.
    
    This is called automatically by the MCP server middleware
    when a training session is active.
    
    Args:
        tool: Name of the tool called
        args: Arguments passed to the tool
        result: Result returned by the tool
    
    Returns:
        True if recorded, False if no active session
    """
    manager = get_session_manager()
    return manager.record_tool_call(tool, args, result)
