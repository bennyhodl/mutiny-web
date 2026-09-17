//! mutiny-sidecar — runs next to ldk-server and serves the mutiny-web wallet.
//!
//! ldk-server speaks native gRPC over HTTP/2 + TLS with a self-signed (pinned)
//! cert and an HMAC `x-auth` header — none of which a browser can do, and the API
//! key must never reach the client. This service is the only thing that holds the
//! secrets: it accepts plain JSON from the web app and forwards each call through
//! the official `ldk-server-client` (which does the framing, TLS pinning, and HMAC).
//!
//! Contract with the browser:
//!   POST /api/rpc/<method>   body = request as JSON  ->  response as JSON
//!   GET  /api/events         Server-Sent Events stream of EventEnvelope JSON
//!   GET  /api/config         { network }
//!   /api/auth/*              password + passkey sign-in, see auth.rs
//!
//! The JSON shape is `ldk-server-grpc`'s serde representation (snake_case).

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use futures::stream::Stream;
use ldk_server_client::client::LdkServerClient;
use ldk_server_client::error::{LdkServerError, LdkServerErrorCode};
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

mod auth;
mod config;
mod passkeys;
use config::{Auth, Config};

#[derive(Clone)]
struct AppState {
    client: Arc<LdkServerClient>,
    network: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let cfg = Config::from_env()?;
    let client = LdkServerClient::new(cfg.grpc_address.clone(), cfg.api_key, &cfg.tls_cert)
        .map_err(|e| anyhow::anyhow!("failed to build ldk-server client: {e}"))?;
    let state = AppState { client: Arc::new(client), network: cfg.network.clone() };
    let auth = Arc::new(cfg.auth);

    // Unauthenticated by necessity: the liveness probe and the endpoints that
    // perform the sign-in itself. Nothing here touches ldk-server.
    let public = Router::new()
        .route("/api/health", get(|| async { Json(json!({ "ok": true })) }))
        .route("/api/auth/me", get(auth::me))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/passkey/login/start", post(auth::passkey_login_start))
        .route("/api/auth/passkey/login/finish", post(auth::passkey_login_finish))
        .with_state(auth.clone());

    // Passkey enrolment needs a session: the password gates the first passkey.
    let protected_auth = Router::new()
        .route("/api/auth/passkeys", get(auth::passkey_list))
        .route("/api/auth/passkey/register/start", post(auth::passkey_register_start))
        .route("/api/auth/passkey/register/finish", post(auth::passkey_register_finish))
        .route("/api/auth/passkey/delete", post(auth::passkey_delete))
        .with_state(auth.clone())
        .layer(axum::middleware::from_fn_with_state(auth.clone(), auth::require_auth));

    // Everything that can reach the node. The middleware is applied with `layer`
    // (not `route_layer`) on a router that holds *only* these routes, so there is
    // no path into an RPC or the event stream that skips the session check.
    let protected = Router::new()
        .merge(rpc_routes())
        .route("/api/events", get(events))
        .route("/api/config", get(wallet_config))
        .with_state(state)
        .layer(axum::middleware::from_fn_with_state(auth.clone(), auth::require_auth));

    // Cookies are only sent cross-origin with explicit credentials support, and
    // that is incompatible with a wildcard origin — hence the exact WEB_ORIGIN.
    // In practice both dev (Vite proxies /api) and prod (one binary) are
    // same-origin, so this only matters if you front the sidecar from another host.
    let cors = CorsLayer::new()
        .allow_origin(cfg.web_origin.parse::<axum::http::HeaderValue>().unwrap())
        .allow_credentials(true)
        .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
        .allow_headers([axum::http::header::CONTENT_TYPE]);

    let mut app = public.merge(protected_auth).merge(protected).layer(cors);

    // Serve the built web app from "/" when WEB_DIR is set, so a single binary
    // hosts both the UI and the API. /assets/* are static files; everything else
    // not matched by /api falls back to index.html (single-page app).
    //
    // The SPA shell is deliberately served unauthenticated: it holds no secrets
    // (every one lives in this process) and it needs to load in order to render
    // the sign-in screen. All of its data comes from the gated /api routes above.
    if let Some(web_dir) = &cfg.web_dir {
        let index_html = std::fs::read_to_string(web_dir.join("index.html"))
            .map_err(|e| anyhow::anyhow!("reading {}/index.html: {e}", web_dir.display()))?;
        app = app.nest_service("/assets", ServeDir::new(web_dir.join("assets"))).fallback_service(
            ServeDir::new(web_dir).fallback(axum::routing::get(move || {
                let html = index_html.clone();
                async move { axum::response::Html(html) }
            })),
        );
        tracing::info!("serving web app from {}", web_dir.display());
    }

    let app = app.layer(TraceLayer::new_for_http());

    // The one structural guarantee worth having: an unauthenticated instance is
    // reachable only from the machine it runs on. `WALLET_AUTH=off` is fine for
    // local development, but it can never accidentally become a public spending API.
    let host = match auth.as_ref() {
        Auth::Password(_) => "0.0.0.0",
        Auth::Disabled => {
            tracing::warn!(
                "WALLET_AUTH=off — no authentication. Binding 127.0.0.1 only; \
                 set WALLET_PASSWORD to serve this anywhere else."
            );
            "127.0.0.1"
        }
    };

    let listener = tokio::net::TcpListener::bind((host, cfg.port)).await?;
    tracing::info!("sidecar listening on http://{host}:{}", cfg.port);
    tracing::info!("proxying gRPC to {} ({})", cfg.grpc_address, cfg.network);
    axum::serve(listener, app).await?;
    Ok(())
}

/// Static facts the wallet needs before its first RPC.
async fn wallet_config(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "network": state.network }))
}

/// Map an ldk-server error to an HTTP status + JSON body the browser can branch on.
fn err_response(e: LdkServerError) -> (StatusCode, Json<Value>) {
    use LdkServerErrorCode::*;
    let status = match e.error_code {
        InvalidRequestError => StatusCode::BAD_REQUEST,
        AuthError => StatusCode::UNAUTHORIZED,
        LightningError => StatusCode::CONFLICT,
        InternalServerError | InternalError => StatusCode::BAD_GATEWAY,
    };
    (status, Json(json!({ "code": e.error_code.to_string(), "message": e.message })))
}

/// Generates one typed JSON handler per RPC and wires the routes.
///
/// Each handler: parse JSON body into the proto request type, call the client
/// method, serialize the proto response back to JSON. Adding an RPC = one line.
macro_rules! rpc_routes {
    ($($path:literal => $method:ident ( $req:ty )),+ $(,)?) => {
        fn rpc_routes() -> Router<AppState> {
            let mut r = Router::new();
            $(
                r = r.route(
                    concat!("/api/rpc/", $path),
                    post(|State(state): State<AppState>,
                          body: Option<Json<Value>>| async move {
                        tracing::info!(rpc = $path, "rpc");

                        let raw = body.map(|b| b.0).unwrap_or_else(|| json!({}));
                        let request: $req = match serde_json::from_value(raw) {
                            Ok(req) => req,
                            Err(e) => {
                                return (
                                    StatusCode::BAD_REQUEST,
                                    Json(json!({ "code": "InvalidRequestError", "message": e.to_string() })),
                                ).into_response();
                            }
                        };
                        match state.client.$method(request).await {
                            Ok(resp) => Json(serde_json::to_value(resp).unwrap()).into_response(),
                            Err(e) => err_response(e).into_response(),
                        }
                    }),
                );
            )+
            r
        }
    };
}

use ldk_server_grpc::api::*;

// The wallet surface. Every entry is one authenticated, typed endpoint.
rpc_routes! {
    // Overview
    "GetNodeInfo"            => get_node_info(GetNodeInfoRequest),
    "GetBalances"            => get_balances(GetBalancesRequest),
    // On-chain
    "OnchainReceive"         => onchain_receive(OnchainReceiveRequest),
    "OnchainSend"            => onchain_send(OnchainSendRequest),
    // Channels
    "ListChannels"           => list_channels(ListChannelsRequest),
    "OpenChannel"            => open_channel(OpenChannelRequest),
    "CloseChannel"           => close_channel(CloseChannelRequest),
    "ForceCloseChannel"      => force_close_channel(ForceCloseChannelRequest),
    "UpdateChannelConfig"    => update_channel_config(UpdateChannelConfigRequest),
    "SpliceIn"               => splice_in(SpliceInRequest),
    "SpliceOut"              => splice_out(SpliceOutRequest),
    // Payments
    "Bolt11Receive"          => bolt11_receive(Bolt11ReceiveRequest),
    "Bolt11ReceiveViaJitChannel" => bolt11_receive_via_jit_channel(Bolt11ReceiveViaJitChannelRequest),
    "Bolt11ReceiveVariableAmountViaJitChannel" => bolt11_receive_variable_amount_via_jit_channel(Bolt11ReceiveVariableAmountViaJitChannelRequest),
    "Bolt11Send"             => bolt11_send(Bolt11SendRequest),
    "Bolt12Receive"          => bolt12_receive(Bolt12ReceiveRequest),
    "Bolt12Send"             => bolt12_send(Bolt12SendRequest),
    "SpontaneousSend"        => spontaneous_send(SpontaneousSendRequest),
    "UnifiedSend"            => unified_send(UnifiedSendRequest),
    "ListPayments"           => list_payments(ListPaymentsRequest),
    "GetPaymentDetails"      => get_payment_details(GetPaymentDetailsRequest),
    // Peers
    "ConnectPeer"            => connect_peer(ConnectPeerRequest),
    "DisconnectPeer"         => disconnect_peer(DisconnectPeerRequest),
    "ListPeers"              => list_peers(ListPeersRequest),
    // Utilities
    "DecodeInvoice"          => decode_invoice(DecodeInvoiceRequest),
    "DecodeOffer"            => decode_offer(DecodeOfferRequest),
    "SignMessage"            => sign_message(SignMessageRequest),
    "VerifySignature"        => verify_signature(VerifySignatureRequest),
    // Network graph (used to resolve node_id -> alias)
    "GraphGetNode"           => graph_get_node(GraphGetNodeRequest),
}

/// Bridge ldk-server's server-streaming `SubscribeEvents` RPC to browser SSE.
async fn events(
    State(state): State<AppState>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, impl IntoResponse> {
    let stream = match state.client.subscribe_events().await {
        Ok(s) => s,
        Err(e) => return Err(err_response(e)),
    };

    let sse = async_stream::stream! {
        // Send something at once so the browser's EventSource reports "open"
        // without waiting for the first node event or keep-alive.
        yield Ok(Event::default().event("ready").data("{}"));
        let mut stream = stream;
        loop {
            match stream.next_message().await {
                Some(Ok(envelope)) => {
                    let data = serde_json::to_string(&envelope).unwrap_or_else(|_| "{}".into());
                    yield Ok(Event::default().event("ldk").data(data));
                }
                Some(Err(e)) => {
                    yield Ok(Event::default()
                        .event("error")
                        .data(json!({ "message": e.message }).to_string()));
                    break;
                }
                None => break,
            }
        }
    };

    Ok(Sse::new(sse).keep_alive(
        axum::response::sse::KeepAlive::new().interval(std::time::Duration::from_secs(10)),
    ))
}
