"""
Quick Start Example for AgentEval

This example demonstrates the basic usage of the AgentEval framework.
"""

from agent_eval import get_caller, DEFAULT_MODEL


def main():
    print("AgentEval Quick Start")
    print("=" * 50)
    print(f"Default model: {DEFAULT_MODEL}")
    print()

    # Example 1: Simple math task
    print("Example 1: Simple math task")
    print("-" * 30)

    caller = get_caller("nanobot")
    response = caller.call(
        {
            "task_id": "math-001",
            "problem_statement": "What is 25+25? Answer in just one number.",
        },
        timeout=60,
    )

    print(f"Agent: nanobot")
    print(f"Success: {response.success}")
    print(f"Output: {response.output.strip()}")
    print(f"Duration: {response.duration:.2f}s")
    print()

    # Example 2: Using different agents
    print("Example 2: Comparing agents")
    print("-" * 30)

    agents = ["nanobot", "hermes", "zeroclaw"]
    task = {"problem_statement": "What is 10+10? Answer in just one number."}

    for agent in agents:
        caller = get_caller(agent)
        response = caller.call(task, timeout=60)
        print(
            f"{agent:12}: success={response.success}, output={response.output.strip()[:30]}"
        )

    print()

    # Example 3: Code-related task
    print("Example 3: Code task")
    print("-" * 30)

    caller = get_caller("opencode")
    response = caller.call(
        {
            "task_id": "code-001",
            "problem_statement": "Write a Python function that returns the factorial of n.",
        },
        timeout=60,
    )

    print(f"Agent: opencode")
    print(f"Success: {response.success}")
    print(f"Output length: {len(response.output)} chars")
    print()


if __name__ == "__main__":
    main()
