# AgentEval

**A Unified Framework for Evaluating and Benchmarking LLM Coding Agents**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-green.svg)](https://www.python.org/downloads/)

---

## Overview

AgentEval is a Python framework designed for systematic evaluation of Large Language Model (LLM) coding agents. It provides researchers and engineers with a consistent, reproducible interface for benchmarking diverse agent implementations across various coding tasks and LLM backends.

The framework leverages Docker containers to ensure environment consistency and supports multiple agent types including Nanobot, Hermes, ZeroClaw, OpenClaw, KiloCode, OpenCode, Codex, Claude Code, Droid, and Grok CLI. Through OpenRouter integration, it provides access to over 200 models from providers such as Anthropic, OpenAI, Google, Meta, and open-source alternatives.

## Key Capabilities

- **Unified Agent Interface**: Call any supported agent using a single, consistent Python API
- **Docker-Based Isolation**: Each agent runs in an isolated container environment for reproducible results
- **Multi-Model Support**: Seamlessly switch between 200+ models via OpenRouter
- **Flexible Configuration**: Per-agent model defaults with runtime override capability
- **Security-First Design**: API keys stored in local files, never hardcoded in source
- **Extensible Architecture**: Add new agents by implementing the AgentCaller interface

## Installation

### Prerequisites

- Python 3.10 or higher
- Docker Engine 20.10+
- OpenRouter API key (free tier available)

### Steps

```bash
# Clone the repository
git clone https://github.com/your-org/agent-eval.git
cd agent-eval

# Create and activate a virtual environment (recommended)
python -m venv .venv
source .venv/bin/activate  # Linux/macOS
# .\venv\Scripts\activate  # Windows

# Install the package
pip install -e .

# Obtain your OpenRouter API key from https://openrouter.ai/keys
# Place it in your home directory
echo "sk-or-v1-your-key" > ~/privacy_secret_openrouter_API_key.txt

# Verify installation
python -c "from agent_eval import get_caller; print('Installation successful!')"
```

## Quick Start

### Basic Usage

```python
from agent_eval import get_caller

# Initialize an agent caller
caller = get_caller('nanobot')

# Execute a task
response = caller.call({
    'task_id': 'example-001',
    'problem_statement': 'Implement a function that returns the factorial of n.'
}, timeout=120)

# Examine results
print(f"Success: {response.success}")
print(f"Output:\n{response.output}")
print(f"Execution time: {response.duration:.2f}s")
```

### Benchmarking Multiple Agents

```python
from agent_eval import get_caller
import json

# Define your evaluation task
task = {
    'task_id': 'benchmark-001',
    'problem_statement': 'Write a Python function to check if a string is a palindrome.'
}

# Select agents to benchmark
agents = ['nanobot', 'hermes', 'zeroclaw', 'openclaw', 'kilo_code', 'opencode']

# Run evaluation
results = {}
for agent in agents:
    caller = get_caller(agent)
    response = caller.call(task, timeout=180)
    results[agent] = {
        'success': response.success,
        'duration': response.duration,
        'output_length': len(response.output)
    }

# Save results
print(json.dumps(results, indent=2))
```

### Custom Model Selection

```python
from agent_eval import get_caller, DEFAULT_MODEL

caller = get_caller('nanobot')

# Use default model (openrouter/free)
response1 = caller.call(task, model=DEFAULT_MODEL)

# Use a specific model
response2 = caller.call(task, model='anthropic/claude-sonnet-4.6')

# Use OpenRouter auto-routing
response3 = caller.call(task, model='openrouter/auto')
```

## Supported Agents

| Agent | Type | Default Model | Container |
|-------|------|---------------|-----------|
| nanobot | Python-based | openrouter/free | nanobot:latest |
| hermes | Self-evolving | openrouter/free | hermes:latest |
| zeroclaw | Rust-based | openrouter/free | zeroclaw:latest |
| openclaw | CLI-based | openrouter/auto | openclaw:latest |
| kilo_code | Node.js | kilo/openrouter/free | kilo_code:latest |
| opencode | Go-based | opencode/big-pickle | opencode:latest |
| codex | CLI | openrouter/free | codex:latest |
| claude_code | CLI | anthropic/claude-sonnet-4.6 | claude_code:latest |
| droid | CLI | openrouter/free | droid:latest |
| grok_cli | CLI | openrouter/free | grok_cli:latest |

## API Reference

### Core Functions

#### `get_caller(agent_type: str) -> AgentCaller`

Factory function that returns a caller instance for the specified agent.

**Parameters:**
- `agent_type` (str): Identifier for the agent ('nanobot', 'hermes', etc.)

**Returns:**
- `AgentCaller`: Instance capable of executing tasks via the specified agent

**Example:**
```python
caller = get_caller('hermes')
```

### AgentCaller Interface

#### `AgentCaller.call(task_input, timeout=300, model=None) -> AgentResponse`

Execute a task using the agent.

**Parameters:**
- `task_input` (dict): Task specification with keys:
  - `problem_statement` (str, required): Description of the task
  - `task_id` (str, optional): Unique identifier for tracking
  - `repo` (str, optional): Repository path for code tasks
  - `test_patch` (str, optional): Test code or patches to apply
- `timeout` (int): Maximum execution time in seconds (default: 300)
- `model` (str): Model identifier (default: agent's default model)

**Returns:**
- `AgentResponse`: Object containing execution results

### AgentResponse Object

| Attribute | Type | Description |
|----------|------|-------------|
| success | bool | Whether the task completed successfully |
| output | str | Agent's textual output |
| error | str | Error message if failed, None otherwise |
| duration | float | Execution time in seconds |
| task_id | str | The task identifier provided |

### Model Registry

```python
from agent_eval.models import (
    DEFAULT_MODEL,              # 'openrouter/free'
    AGENT_DEFAULT_MODELS,      # Dict mapping agent to their default
    OPENROUTER_FREE_MODELS,    # List of available free models
    get_default_model_for_agent # Function to get agent's default
)

# Print all free models
for model in OPENROUTER_FREE_MODELS:
    print(f"  - {model}")
```

## Container Management

### Using the Management Script

```bash
# Navigate to containers directory
cd containers

# Start all agent containers
./agent_containers.sh start

# Check container status
./agent_containers.sh status

# Access a specific container shell
./agent_containers.sh exec nanobot
./agent_containers.sh exec hermes

# Stop all containers
./agent_containers.sh stop

# Restart a specific container
./agent_containers.sh restart zeroclaw
```

### Direct Docker Commands

```bash
# List running containers
docker ps | grep -E 'nanobot|hermes|zeroclaw|openclaw|kilo_code|opencode'

# View container logs
docker logs nanobot

# Execute commands in container
docker exec nanobot nanobot --version
```

## Security Considerations

### API Key Management

API keys are never stored in source code or Docker images. Keys are read from a local privacy file at runtime.

**Privacy File Location:**
```
~/privacy_secret_openrouter_API_key.txt
```

**Security Best Practices:**
1. Never commit privacy files to version control
2. Set restrictive file permissions: `chmod 600 ~/privacy_secret_openrouter_API_key.txt`
3. Rotate API keys periodically
4. For production deployments, use Docker Secrets or Kubernetes Secrets

See [docs/DOCKER_SECRETS.md](docs/DOCKER_SECRETS.md) for comprehensive security guidance.

## Project Structure

```
agent-eval/
├── src/agent_eval/              # Core Python package
│   ├── __init__.py            # Package exports and version
│   ├── callers.py              # AgentCaller implementations
│   ├── api_keys.py            # API key management
│   └── models.py              # Model registry and defaults
├── containers/                  # Container configurations
│   ├── agent_containers.sh     # Container management CLI
│   └── configs/               # Per-agent configurations
├── examples/                   # Usage examples
│   └── quickstart.py          # Getting started example
├── tests/                     # Test suite
│   └── test_callers.py        # Unit tests
├── docs/                      # Documentation
│   └── docker_secrets_guide.md
├── .gitignore                 # Git ignore patterns
├── LICENSE                    # MIT License
├── README.md                  # This file
└── pyproject.toml            # Package metadata
```

## Testing

```bash
# Run all tests
pytest tests/ -v

# Run with coverage
pytest tests/ --cov=src/agent_eval --cov-report=html

# Run specific test
pytest tests/test_callers.py::test_get_caller -v
```

## Contributing

Contributions are welcome. Please follow these guidelines:

1. **Fork and create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Follow existing code style** and maintain type hints

3. **Add tests** for new functionality

4. **Ensure all tests pass**
   ```bash
   pytest tests/ -v
   ```

5. **Update documentation** for any API changes

6. **Submit a pull request** with a clear description of changes

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Research Attribution

This framework was developed as part of independent research on LLM agents by Zi Liang. It provides the evaluation infrastructure necessary for rigorous, reproducible assessment of agent capabilities across diverse problem domains and model configurations.

## Citation

If you use AgentEval in your research, please cite:

```bibtex
@software{agenteval2026,
  title = {AgentEval: A Unified Framework for Evaluating LLM Coding Agents},
  author = {Zi Liang},
  year = {2026},
  url = {https://github.com/liangzid/agent-eval}
}
```

## Contact

For questions, issues, or collaboration inquiries:
- Open an issue on GitHub
- Submit a pull request
- Email: zi1415926.liang@connect.polyu.hk

---

*Last updated: 2026-04-17*
