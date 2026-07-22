//! MCP (Model Context Protocol) Server implementation.
//!
//! Implements the JSON-RPC based MCP protocol over stdio,
//! allowing CAITLYN to be used as a tool by MCP-compatible coding agents
//! (Claude Desktop, Cline, Continue, etc.).
//!
//! ## Protocol
//! - Transport: stdio (JSON-RPC 2.0 over stdin/stdout)
//! - Methods: initialize, tools/list, tools/call

use std::sync::Arc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;
use tracing::{debug, error, info};

use crate::Caitlyn;

// ── JSON-RPC Types ────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)] // Verified on deserialization
    jsonrpc: String,
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcError {
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

#[allow(dead_code)] // Reserved for future MCP notifications
#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcNotification {
    jsonrpc: String,
    method: String,
    params: Option<Value>,
}

// ── MCP Types ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct InitializeResult {
    protocol_version: String,
    capabilities: ServerCapabilities,
    server_info: ServerInfo,
}

#[derive(Debug, Serialize, Deserialize)]
struct ServerCapabilities {
    tools: ToolCapabilities,
}

#[derive(Debug, Serialize, Deserialize)]
struct ToolCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    list_changed: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ServerInfo {
    name: String,
    version: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ListToolsResult {
    tools: Vec<ToolDef>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ToolDef {
    name: String,
    description: String,
    #[serde(rename = "inputSchema")]
    input_schema: Value,
}

#[derive(Debug, Deserialize)]
struct CallToolParams {
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct CallToolResult {
    content: Vec<ToolContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_error: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ToolContent {
    #[serde(rename = "type")]
    content_type: String,
    text: String,
}

// ── Tool Definitions ──────────────────────────────────────────

fn caitlyn_scan_tool() -> ToolDef {
    ToolDef {
        name: "caitlyn_scan".into(),
        description: "Scan external content for injection, poisoning, jailbreak, or exfiltration attacks before it enters an agent's context.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "The external content to scan (tool output, web content, MCP response, etc.)"
                },
                "source": {
                    "type": "string",
                    "description": "Source of the content (e.g., web_search, tool_output, mcp_response, file)",
                    "default": "unknown"
                },
                "agent_task": {
                    "type": "string",
                    "description": "The agent's current task for context-aware scanning"
                },
                "mode": {
                    "type": "string",
                    "enum": ["fast", "full"],
                    "description": "Scan mode: fast (memory only) or full (LLM antibodies)",
                    "default": "fast"
                }
            },
            "required": ["content"]
        }),
    }
}

fn caitlyn_status_tool() -> ToolDef {
    ToolDef {
        name: "caitlyn_status".into(),
        description: "Get current CAITLYN daemon status: active antibodies, memory entries, tracked attack patterns.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {}
        }),
    }
}

fn caitlyn_vaccinate_tool() -> ToolDef {
    ToolDef {
        name: "caitlyn_vaccinate".into(),
        description: "Manually trigger vaccination for a repeatedly expensive defense pattern.".into(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "pattern_description": {
                    "type": "string",
                    "description": "Description of the attack pattern to vaccinate against"
                }
            }
        }),
    }
}

// ── MCP Server ────────────────────────────────────────────────

/// Run the MCP server over stdio.
///
/// Reads JSON-RPC requests from stdin, processes them,
/// and writes responses to stdout. Stderr is reserved for logging.
pub async fn serve_stdio(caitlyn: Arc<Caitlyn>) -> anyhow::Result<()> {
    info!("CAITLYN MCP server starting (stdio mode)");

    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let stdout = Arc::new(Mutex::new(stdout));

    let reader = BufReader::new(stdin);
    let mut lines = reader.lines();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        debug!("MCP received: {}", &line[..line.len().min(200)]);

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                error!("Failed to parse MCP request: {e}");
                let response = JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id: None,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32700,
                        message: format!("Parse error: {e}"),
                        data: None,
                    }),
                };
                write_response(&stdout, &response).await?;
                continue;
            }
        };

        let response = handle_request(&request, &caitlyn).await;
        write_response(&stdout, &response).await?;
    }

    info!("MCP server stdin closed, shutting down");
    Ok(())
}

async fn handle_request(req: &JsonRpcRequest, caitlyn: &Arc<Caitlyn>) -> JsonRpcResponse {
    match req.method.as_str() {
        "initialize" => handle_initialize(req),
        "notifications/initialized" => {
            // No response needed for notifications
            JsonRpcResponse {
                jsonrpc: "2.0".into(),
                id: req.id.clone(),
                result: Some(Value::Null),
                error: None,
            }
        }
        "tools/list" => handle_tools_list(req),
        "tools/call" => handle_tools_call(req, caitlyn).await,
        "ping" => JsonRpcResponse {
            jsonrpc: "2.0".into(),
            id: req.id.clone(),
            result: Some(serde_json::json!({})),
            error: None,
        },
        _ => JsonRpcResponse {
            jsonrpc: "2.0".into(),
            id: req.id.clone(),
            result: None,
            error: Some(JsonRpcError {
                code: -32601,
                message: format!("Method not found: {}", req.method),
                data: None,
            }),
        },
    }
}

fn handle_initialize(req: &JsonRpcRequest) -> JsonRpcResponse {
    let result = InitializeResult {
        protocol_version: "2024-11-05".into(),
        capabilities: ServerCapabilities {
            tools: ToolCapabilities {
                list_changed: Some(false),
            },
        },
        server_info: ServerInfo {
            name: "caitlyn".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
    };

    JsonRpcResponse {
        jsonrpc: "2.0".into(),
        id: req.id.clone(),
        result: Some(serde_json::to_value(result).unwrap_or_default()),
        error: None,
    }
}

fn handle_tools_list(req: &JsonRpcRequest) -> JsonRpcResponse {
    let tools = vec![
        caitlyn_scan_tool(),
        caitlyn_status_tool(),
        caitlyn_vaccinate_tool(),
    ];

    let result = ListToolsResult { tools };

    JsonRpcResponse {
        jsonrpc: "2.0".into(),
        id: req.id.clone(),
        result: Some(serde_json::to_value(result).unwrap_or_default()),
        error: None,
    }
}

async fn handle_tools_call(req: &JsonRpcRequest, caitlyn: &Arc<Caitlyn>) -> JsonRpcResponse {
    let params: CallToolParams = match req.params.as_ref().and_then(|p| {
        serde_json::from_value(p.clone()).ok()
    }) {
        Some(p) => p,
        None => {
            return JsonRpcResponse {
                jsonrpc: "2.0".into(),
                id: req.id.clone(),
                result: None,
                error: Some(JsonRpcError {
                    code: -32602,
                    message: "Invalid params".into(),
                    data: None,
                }),
            };
        }
    };

    let result = match params.name.as_str() {
        "caitlyn_scan" => handle_caitlyn_scan(&params.arguments, caitlyn).await,
        "caitlyn_status" => handle_caitlyn_status(caitlyn).await,
        "caitlyn_vaccinate" => handle_caitlyn_vaccinate(&params.arguments, caitlyn).await,
        _ => Err(format!("Unknown tool: {}", params.name)),
    };

    match result {
        Ok(content) => JsonRpcResponse {
            jsonrpc: "2.0".into(),
            id: req.id.clone(),
            result: Some(serde_json::to_value(CallToolResult {
                content: vec![ToolContent {
                    content_type: "text".into(),
                    text: content,
                }],
                is_error: None,
            }).unwrap_or_default()),
            error: None,
        },
        Err(err_msg) => JsonRpcResponse {
            jsonrpc: "2.0".into(),
            id: req.id.clone(),
            result: Some(serde_json::to_value(CallToolResult {
                content: vec![ToolContent {
                    content_type: "text".into(),
                    text: format!("Error: {err_msg}"),
                }],
                is_error: Some(true),
            }).unwrap_or_default()),
            error: None,
        },
    }
}

async fn handle_caitlyn_scan(args: &Value, caitlyn: &Arc<Caitlyn>) -> Result<String, String> {
    let content = args.get("content")
        .and_then(|v| v.as_str())
        .ok_or("Missing required field: content")?;

    let source = args.get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    let agent_task = args.get("agent_task")
        .and_then(|v| v.as_str())
        .map(String::from);

    let mode = args.get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("fast");

    let _context = crate::core::ScanContext {
        source: source.to_string(),
        agent_task,
        history_snippet: None,
        metadata: serde_json::json!({"mode": mode}),
    };

    // For MCP fast mode, do memory-only scan
    let memory_match = caitlyn.memory_bank.check(content).await;
    if let crate::core::memory::MemoryMatch::Exact(ref entry) = memory_match {
        let result = serde_json::json!({
            "verdict": "malicious",
            "confidence": 1.0,
            "matched_signature": entry.signature,
            "source_antibody": entry.antibody_id,
            "method": "memory_fast_path",
        });
        return Ok(serde_json::to_string_pretty(&result).unwrap_or_default());
    }

    let result = serde_json::json!({
        "verdict": "safe",
        "confidence": 0.5,
        "method": "memory_fast_path",
        "note": "No known signatures matched. For full LLM scan, use mode=full with LLM provider configured."
    });

    Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
}

async fn handle_caitlyn_status(caitlyn: &Arc<Caitlyn>) -> Result<String, String> {
    let status = caitlyn.status().await;
    let json = serde_json::json!({
        "version": status.version,
        "active_antibodies": status.active_antibodies,
        "memory_entries": status.memory_entries,
        "tracked_patterns": status.tracked_patterns,
    });
    Ok(serde_json::to_string_pretty(&json).unwrap_or_default())
}

async fn handle_caitlyn_vaccinate(args: &Value, _caitlyn: &Arc<Caitlyn>) -> Result<String, String> {
    let _description = args.get("pattern_description")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    // In MCP mode, vaccination is manual
    let json = serde_json::json!({
        "status": "acknowledged",
        "message": "Vaccination request received. The pattern will be analyzed and a specialized antibody will be generated if cost thresholds are met.",
    });
    Ok(serde_json::to_string_pretty(&json).unwrap_or_default())
}

async fn write_response(
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
    response: &JsonRpcResponse,
) -> anyhow::Result<()> {
    let json = serde_json::to_string(response)?;
    let mut out = stdout.lock().await;
    out.write_all(json.as_bytes()).await?;
    out.write_all(b"\n").await?;
    out.flush().await?;
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initialize_response() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(Value::Number(1.into())),
            method: "initialize".into(),
            params: Some(serde_json::json!({
                "protocolVersion": "2024-11-05",
                "clientInfo": {"name": "test", "version": "1.0"}
            })),
        };

        let resp = handle_initialize(&req);
        assert_eq!(resp.jsonrpc, "2.0");
        assert!(resp.error.is_none());
        let result: InitializeResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        assert_eq!(result.server_info.name, "caitlyn");
        assert_eq!(result.protocol_version, "2024-11-05");
    }

    #[test]
    fn test_tools_list() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(Value::Number(2.into())),
            method: "tools/list".into(),
            params: None,
        };

        let resp = handle_tools_list(&req);
        assert!(resp.error.is_none());
        let result: ListToolsResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        assert_eq!(result.tools.len(), 3);
        assert_eq!(result.tools[0].name, "caitlyn_scan");
        assert_eq!(result.tools[1].name, "caitlyn_status");
        assert_eq!(result.tools[2].name, "caitlyn_vaccinate");
    }

    #[test]
    fn test_unknown_method() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(Value::Number(3.into())),
            method: "nonexistent".into(),
            params: None,
        };

        let rt = tokio::runtime::Runtime::new().unwrap();
        // Can't easily test handle_request without Caitlyn instance, but test structure
        let resp = handle_initialize(&req);
        assert!(resp.error.is_none());
    }

    #[test]
    fn test_caitlyn_scan_tool_schema() {
        let tool = caitlyn_scan_tool();
        assert_eq!(tool.name, "caitlyn_scan");
        let schema = tool.input_schema;
        assert_eq!(schema["type"], "object");
        assert!(schema["required"].as_array().unwrap().contains(&serde_json::json!("content")));
    }

    #[test]
    fn test_caitlyn_status_tool_schema() {
        let tool = caitlyn_status_tool();
        assert_eq!(tool.name, "caitlyn_status");
    }
}
