"""Verification of Phase 4 corrections (Section 9b)."""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from seo_agents.actions import _build_validated_task, _write_task_graph_from_actions

# Task 4.1: ordinary executable task with empty claims -> research_gap
result = _build_validated_task(
    {
        "id": "task-x",
        "action_type": "content_update",
        "supporting_claim_ids": [],
        "title": "test update",
        "status": "dry_run_ready",
        "dependencies": [],
    },
    {},  # claim_map
    "run-1",
    [],
    [],
)
assert result["status"] == "research_gap", f"Expected research_gap, got {result['status']}"
print(f"✅ Task 4.1: ordinary task with empty claims -> status={result['status']}")

# Task 4.3: dependency blocking propagation
# Build two actions where A-2 depends on A-1 which is blocked
import tempfile
from pathlib import Path

with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)
    # Patch OUTPUT_DIR temporarily
    import seo_agents.evidence as ev
    ev.OUTPUT_DIR = tmp
    ev.TASK_GRAPH_PATH = tmp / "task_graph.json"
    ev.EVIDENCE_PACKAGE_PATH = tmp / "evidence_package.json"
    ev.CLAIM_GRAPH_PATH = tmp / "claim_graph.json"

    # Build a simple action list: A-1 has empty claims (blocked by 4.1 fix),
    # A-2 depends on A-1
    actions = [
        {
            "id": "action-a1",
            "action_type": "content_update",
            "supporting_claim_ids": [],
            "title": "Task A-1",
            "status": "dry_run_ready",
            "dependencies": [],
            "source_task_id": "T001",
        },
        {
            "id": "action-a2",
            "action_type": "website_copy_update",
            "supporting_claim_ids": ["claim_abc123"],
            "title": "Task A-2",
            "status": "dry_run_ready",
            "dependencies": ["T-run-1-T001"],
            "source_task_id": "T002",
        },
    ]
    
    # Write empty evidence/claim to avoid errors
    (tmp / "evidence_package.json").write_text('{"run_id":"run-1","evidence":[]}')
    (tmp / "claim_graph.json").write_text('{"run_id":"run-1","claims":[{"claim_id":"claim_abc123","status":"confirmed"}]}')

    _write_task_graph_from_actions(actions, "run-1")

    # Load the written task graph
    tg = json.loads(open(tmp / "task_graph.json").read())
    tasks = tg["tasks"]
    
    # Find the two tasks
    a1_task = next((t for t in tasks if t["action_id"] == "action-a1"), None)
    a2_task = next((t for t in tasks if t["action_id"] == "action-a2"), None)
    
    print(f"  A-1 status: {a1_task['status']}  (expected: research_gap)")
    print(f"  A-2 status: {a2_task['status']}  (expected: blocked)")
    
    assert a1_task["status"] == "research_gap", f"A-1 should be research_gap, got {a1_task['status']}"
    assert a2_task["status"] == "blocked", f"A-2 should be blocked, got {a2_task['status']}"
    assert any("blocked_dependency" in r for r in a2_task.get("blocking_reasons", [])), \
        f"A-2 should have blocking_reasons naming the blocked dep"
    print("✅ Task 4.3: dependency blocking propagates")

# Task 4.5: verify build_executor_crew loads task_graph.json
from seo_agents.crew import _filter_executable_tasks, BLOCKED_STATUSES
import json

with tempfile.TemporaryDirectory() as td:
    tmp = Path(td)
    tg_data = {
        "run_id": "run-1",
        "tasks": [
            {"task_id": "T1", "status": "ready", "action_id": "a1", "title": "Ready task"},
            {"task_id": "T2", "status": "blocked", "action_id": "a2", "title": "Blocked task"},
            {"task_id": "T3", "status": "research_gap", "action_id": "a3", "title": "Research gap"},
            {"task_id": "T4", "status": "waiting_on_owner", "action_id": "a4", "title": "Waiting"},
        ]
    }
    (tmp / "task_graph.json").write_text(json.dumps(tg_data))
    # Patch TASK_GRAPH_PATH
    import seo_agents.evidence as ev2
    ev2.TASK_GRAPH_PATH = tmp / "task_graph.json"
    
    filtered = _filter_executable_tasks()
    titles = [t["title"] for t in filtered]
    print(f"  Filtered titles: {titles}")
    assert "Ready task" in titles, "Ready task should be included"
    assert "Blocked task" not in titles, "Blocked task should NOT be included"
    assert "Research gap" not in titles, "Research gap should NOT be included"
    assert "Waiting" not in titles, "Waiting task should NOT be included"
    print("✅ Task 4.5: executor crew only gets executable tasks")

print("\nAll Phase 4 corrections verified.")
