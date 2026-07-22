# Docker Secrets and API Key Management

This document describes approaches for handling sensitive API keys in Docker containers without exposing them in Dockerfiles or source code.

## The Problem

Dockerfiles and container images can be leaked or exposed through:
- Image layers in registries
- Docker history commands
- Commit history
- Accidental sharing of images

Hardcoding API keys in Dockerfiles is a security risk.

## Solutions

### 1. Runtime Environment Variables (Recommended for Dev/Test)

Pass API keys at container runtime using `-e` flag or `--env-file`:

```bash
# Single environment variable
docker run -e OPENROUTER_API_KEY="sk-or-v1-xxx" myimage

# Using an env file (one key per line: KEY=value)
docker run --env-file=.env myimage
```

In your Python code:
```python
import os
api_key = os.environ.get("OPENROUTER_API_KEY")
```

**Advantages:**
- Simple to implement
- Works with existing containers
- Easy to rotate keys

**Disadvantages:**
- Visible in `docker inspect` output
- Visible in process environment (`/proc/*/environ`)

### 2. Docker Secrets (Production - Swarm Mode)

Docker Secrets encrypts sensitive data and only exposes it to running services:

```bash
# Create a secret from file
echo "sk-or-v1-xxx" | docker secret create openrouter_api_key -

# Or from literal
docker secret create openrouter_api_key sk-or-v1-xxx

# Use in service
docker service create --secret openrouter_api_key myimage
```

Access in service:
```python
with open('/run/secrets/openrouter_api_key') as f:
    api_key = f.read().strip()
```

**Advantages:**
- Encrypted at rest and in transit
- Only accessible to running containers
- Managed by Docker

**Disadvantages:**
- Requires Docker Swarm
- More complex setup

### 3. Kubernetes Secrets

For Kubernetes deployments:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: api-keys
type: Opaque
stringData:
  OPENROUTER_API_KEY: sk-or-v1-xxx
---
# Mount as environment variable
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: myapp
    envFrom:
    - secretRef:
        name: api-keys
```

Or mount as volume:
```yaml
volumes:
- name: api-keys
  secret:
    secretName: api-keys
volumeMounts:
- name: api-keys
  mountPath: /run/secrets
```

### 4. Docker BuildKit Secrets (Build Time)

Use BuildKit to securely pass secrets during image build without caching them:

```bash
# syntax=docker/dockerfile:1.4
FROM base
RUN --mount=type=secret,id=api_key \
    API_KEY=$(cat /run/secrets/api_key) && \
    echo "API_KEY configured"
```

Build with:
```bash
DOCKER_BUILDKIT=1 docker build --secret id=api_key,env=OPENROUTER_API_KEY .
```

**Advantages:**
- Secrets not cached in image layers
- Not visible in image history

**Disadvantages:**
- Requires BuildKit
- Only for build-time secrets

## Our Implementation

In this project, we use a hybrid approach:

### For Python Code

The `api_keys.py` utility reads from a local privacy file:

```python
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.parent
PRIVACY_DIR = PROJECT_ROOT / "privacy_secret_openrouter_API_key.txt"

def get_openrouter_api_key() -> str:
    return PRIVACY_DIR.read_text().strip()
```

### For Docker Containers

We pass the API key at runtime using `-e` flag:

```python
cmd = [
    "docker", "exec", "-e",
    f"OPENROUTER_API_KEY={get_openrouter_api_key()}",
    "container_name",
    "command"
]
```

This approach:
- Keeps API key out of source code
- Keeps API key out of Dockerfiles
- Only exposes key to running container process
- Works with existing containers without rebuilding

## Best Practices

1. **Never commit API keys to version control**
   - Add `privacy_*.txt` to `.gitignore`

2. **Rotate keys regularly**
   - Update the privacy file
   - Restart containers to pick up new keys

3. **Use least-privilege keys**
   - Create keys with minimal permissions
   - Use environment-specific keys

4. **Monitor key usage**
   - Set up usage alerts on API keys
   - Review logs for unauthorized access

5. **For production**
   - Use proper secrets management (Vault, AWS Secrets Manager, etc.)
   - Consider using Docker Secrets or Kubernetes Secrets
