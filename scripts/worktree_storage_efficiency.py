#!/usr/bin/env python3
import os
import subprocess
import shutil
import time

def run(cmd, cwd=None):
    subprocess.run(cmd, shell=True, check=True, cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def get_size(path):
    # Apparent size (bytes)
    apparent = int(subprocess.check_output(f"du -sb {path} | cut -f1", shell=True).decode().strip())
    # Allocated size (kilobytes -> bytes)
    allocated = int(subprocess.check_output(f"du -sk {path} | cut -f1", shell=True).decode().strip()) * 1024
    return apparent, allocated

def setup_canonical(repo_dir):
    if os.path.exists(repo_dir):
        shutil.rmtree(repo_dir)
    os.makedirs(repo_dir)
    run("git init", cwd=repo_dir)
    # create some dummy large files
    run("dd if=/dev/urandom of=big1.bin bs=1M count=10", cwd=repo_dir)
    run("dd if=/dev/urandom of=big2.bin bs=1M count=10", cwd=repo_dir)
    run("git add big1.bin big2.bin", cwd=repo_dir)
    run("git commit -m 'Initial commit with large files'", cwd=repo_dir)

def test_method(method_name, create_cmd_template, counts, base_dir):
    print(f"\n--- Method: {method_name} ---")
    canonical_dir = os.path.join(base_dir, "canonical")
    
    for count in counts:
        # Reset and setup canonical
        setup_canonical(canonical_dir)
        
        ws_base = os.path.join(base_dir, f"ws_{method_name}_{count}")
        if os.path.exists(ws_base):
            shutil.rmtree(ws_base)
        os.makedirs(ws_base)
        
        # Create workspaces
        start = time.time()
        for i in range(count):
            ws_dir = os.path.join(ws_base, f"ws_{i}")
            cmd = create_cmd_template.format(canonical=canonical_dir, ws=ws_dir, branch=f"branch_{i}")
            run(cmd, cwd=base_dir)
        duration = time.time() - start
        
        # Measure total size of canonical + all workspaces
        app_can, alc_can = get_size(canonical_dir)
        app_ws, alc_ws = get_size(ws_base)
        
        total_app = app_can + app_ws
        total_alc = alc_can + alc_ws
        
        print(f"Workspaces: {count:2} | Apparent: {total_app / 1024 / 1024:7.2f} MB | Allocated: {total_alc / 1024 / 1024:7.2f} MB | Time: {duration:5.2f}s")
        
        # Safety check: editable source hardlink test
        # If we edit a file in ws_0, it should NOT affect canonical
        if count > 0:
            ws0_file = os.path.join(ws_base, "ws_0", "big1.bin")
            can_file = os.path.join(canonical_dir, "big1.bin")
            
            # Check for hardlinks by modifying (only if file exists, e.g. not for sparse checks unless it's there)
            if os.path.exists(ws0_file):
                # write a marker to the end of ws0_file
                with open(ws0_file, "ab") as f:
                    f.write(b"MARKER")
                
                # Check if can_file got modified
                with open(can_file, "rb") as f:
                    f.seek(-6, 2)
                    marker = f.read()
                    if marker == b"MARKER":
                        print(f"  [!] DANGER: Editable source hardlink detected in {method_name}!")

if __name__ == '__main__':
    base_dir = "/tmp/worktree_storage_test"
    counts = [1, 5, 10, 20]
    
    test_method("git-worktree", "git -C {canonical} worktree add -b {branch} {ws}", counts, base_dir)
    test_method("git-clone-local", "git clone --local -b main {canonical} {ws}", counts, base_dir)
    test_method("git-clone-shared", "git clone --shared -b main {canonical} {ws}", counts, base_dir)
    test_method("cp-reflink-fallback", "cp --reflink=auto -a {canonical} {ws}", counts, base_dir)
