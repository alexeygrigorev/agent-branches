"""
Unit tests for dogfood_branches_sync pipeline.
Verifies isolated preview, push, and remote recovery invariants.
"""
import pytest
from scripts.dogfood_branches_sync import run_dogfood_pipeline


def test_dogfood_branches_sync_pipeline_end_to_end():
    res = run_dogfood_pipeline()
    assert res["success"] is True
    assert "preview" in res["stages"]
    assert res["stages"]["preview"]["status"] == "PASSED"
    assert "isolated_push" in res["stages"]
    assert res["stages"]["isolated_push"]["status"] == "PASSED"
    assert "remote_recovery" in res["stages"]
    assert res["stages"]["remote_recovery"]["status"] == "PASSED"
    assert res["stages"]["remote_recovery"]["leakage_clean"] is True
