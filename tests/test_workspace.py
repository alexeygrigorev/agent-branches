import os
import shutil
import tempfile
import subprocess
import unittest

from agent_branches.workspace import create_workspace

class TestWorkspace(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.canonical = os.path.join(self.temp_dir, "canonical")
        os.makedirs(self.canonical)
        
        # Init git and create a dummy file
        subprocess.run(["git", "init"], cwd=self.canonical, check=True, stdout=subprocess.DEVNULL)
        self.dummy_file = os.path.join(self.canonical, "dummy.txt")
        with open(self.dummy_file, "w") as f:
            f.write("initial\n")
        subprocess.run(["git", "add", "dummy.txt"], cwd=self.canonical, check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["git", "commit", "-m", "init"], cwd=self.canonical, check=True, stdout=subprocess.DEVNULL)

    def tearDown(self):
        shutil.rmtree(self.temp_dir)

    def test_create_workspace_safety(self):
        ws_dir = os.path.join(self.temp_dir, "ws1")
        method = create_workspace(self.canonical, ws_dir)
        
        # Method should be clone_local on standard ext4 without reflink, or reflink if supported
        self.assertIn(method, ["reflink", "clone_local"])
        
        # Verify it created a git repo
        self.assertTrue(os.path.exists(os.path.join(ws_dir, ".git")))
        
        # Verify no editable source hardlinks
        ws_dummy = os.path.join(ws_dir, "dummy.txt")
        
        # Modify the workspace file
        with open(ws_dummy, "a") as f:
            f.write("modified in ws\n")
            
        # The canonical file should NOT be modified
        with open(self.dummy_file, "r") as f:
            can_content = f.read()
            
        self.assertEqual(can_content, "initial\n")

    def test_target_exists_raises(self):
        ws_dir = os.path.join(self.temp_dir, "ws2")
        os.makedirs(ws_dir)
        with self.assertRaises(ValueError):
            create_workspace(self.canonical, ws_dir)

if __name__ == "__main__":
    unittest.main()
