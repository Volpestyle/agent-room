import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  AgentRoomApiError,
  createAgentRoomClient,
  type DaemonHealth,
  type Message,
  type RoomEvent,
  type RuntimeAgent,
  type RuntimeProviderSummary,
} from "./api";
import {
  defaultConnection,
  isLikelyTailnetUrl,
  loadConnectionSettings,
  normalizeBaseUrl,
  parsePairingUrl,
  saveConnectionSettings,
  type ConnectionMode,
  type ConnectionSettings,
} from "./connection";

const connectionModes: Array<{ mode: ConnectionMode; label: string }> = [
  { mode: "local", label: "Local" },
  { mode: "tailnet", label: "Tailscale" },
  { mode: "custom", label: "Custom" },
];

export function App() {
  const [settings, setSettings] =
    useState<ConnectionSettings>(defaultConnection);
  const [draftMode, setDraftMode] = useState<ConnectionMode>(
    defaultConnection.mode,
  );
  const [draftUrl, setDraftUrl] = useState(defaultConnection.baseUrl);
  const [draftToken, setDraftToken] = useState("");
  const [health, setHealth] = useState<DaemonHealth | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [providers, setProviders] = useState<RuntimeProviderSummary[]>([]);
  const [agents, setAgents] = useState<RuntimeAgent[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [agentInput, setAgentInput] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [agentOutput, setAgentOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const client = useMemo(
    () =>
      createAgentRoomClient({
        baseUrl: settings.baseUrl,
        ...(settings.token ? { token: settings.token } : {}),
      }),
    [settings],
  );

  const applyConnectionSettings = useCallback(
    async (next: ConnectionSettings) => {
      const normalized: ConnectionSettings = {
        mode: next.mode,
        baseUrl: normalizeBaseUrl(next.baseUrl),
        token: next.token.trim(),
      };
      await saveConnectionSettings(normalized);
      setSettings(normalized);
      setDraftMode(normalized.mode);
      setDraftUrl(normalized.baseUrl);
      setDraftToken(normalized.token);
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [healthResult, messagesResult, eventsResult, providerResult] =
        await Promise.all([
          client.health(),
          client.listMessages(),
          client.listEvents(),
          client.listRuntimeProviders(),
        ]);
      const activeProvider =
        selectedProviderId ||
        providerResult.providers.find(
          (provider) => provider.health?.ok !== false,
        )?.id ||
        providerResult.providers[0]?.id ||
        "";
      const agentsResult = activeProvider
        ? await client.listRuntimeAgents(activeProvider)
        : { agents: [] };
      const activeAgent =
        selectedAgentId &&
        agentsResult.agents.some((agent) => agent.id === selectedAgentId)
          ? selectedAgentId
          : agentsResult.agents[0]?.id || "";
      const outputResult =
        activeProvider && activeAgent
          ? await client.readRuntimeAgent(activeProvider, activeAgent)
          : undefined;

      setHealth(healthResult);
      setMessages(messagesResult.messages);
      setEvents(eventsResult.events);
      setProviders(providerResult.providers);
      setSelectedProviderId(activeProvider);
      setAgents(agentsResult.agents);
      setSelectedAgentId(activeAgent);
      setAgentOutput(outputResult?.output.text ?? "");
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [client, selectedAgentId, selectedProviderId]);

  useEffect(() => {
    let mounted = true;
    void loadConnectionSettings().then((loaded) => {
      if (!mounted) return;
      setSettings(loaded);
      setDraftMode(loaded.mode);
      setDraftUrl(loaded.baseUrl);
      setDraftToken(loaded.token);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    async function applyPairingUrl(url: string) {
      const paired = parsePairingUrl(url);
      if (!paired) return;
      setSaving(true);
      setError(null);
      try {
        await applyConnectionSettings(paired);
      } catch (err) {
        if (mounted) setError(formatError(err));
      } finally {
        if (mounted) setSaving(false);
      }
    }

    void Linking.getInitialURL().then((url) => {
      if (mounted && url) void applyPairingUrl(url);
    });
    const subscription = Linking.addEventListener("url", (event) => {
      void applyPairingUrl(event.url);
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [applyConnectionSettings]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function saveConnection() {
    setSaving(true);
    setError(null);
    try {
      const next = {
        mode: draftMode,
        baseUrl: normalizeBaseUrl(draftUrl),
        token: draftToken.trim(),
      };
      await applyConnectionSettings(next);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  async function sendAgentInput() {
    if (!selectedProviderId || !selectedAgentId || !agentInput.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await client.sendRuntimeAgentInput(
        selectedProviderId,
        selectedAgentId,
        agentInput.trim(),
      );
      setAgentInput("");
      await refresh();
    } catch (err) {
      setError(formatError(err));
      setLoading(false);
    }
  }

  async function postRoomMessage() {
    if (!messageBody.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await client.postMessage(messageBody.trim());
      setMessageBody("");
      await refresh();
    } catch (err) {
      setError(formatError(err));
      setLoading(false);
    }
  }

  const tailnetWarning =
    draftMode === "tailnet" && !isLikelyTailnetUrl(draftUrl)
      ? "Use the Tailscale URL from agent-room mobile-connect."
      : null;
  const authLabel = health?.auth?.apiTokenRequired ? "Protected" : "Open local";

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={refresh} />
          }
        >
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>AgentRoom</Text>
              <Text style={styles.subtitle}>
                {health?.roomId ?? "Disconnected"} - {authLabel}
              </Text>
            </View>
            <StatusPill ok={health?.ok === true} loading={loading} />
          </View>

          <View style={styles.panel}>
            <Text style={styles.sectionTitle}>Connection</Text>
            <View style={styles.segmented}>
              {connectionModes.map((item) => (
                <Pressable
                  key={item.mode}
                  style={[
                    styles.segment,
                    draftMode === item.mode && styles.segmentActive,
                  ]}
                  onPress={() => setDraftMode(item.mode)}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      draftMode === item.mode && styles.segmentTextActive,
                    ]}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              value={draftUrl}
              onChangeText={setDraftUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="http://100.x.y.z:4317"
              placeholderTextColor="#8a9099"
              style={styles.input}
            />
            <TextInput
              value={draftToken}
              onChangeText={setDraftToken}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="API token"
              placeholderTextColor="#8a9099"
              style={styles.input}
            />
            {tailnetWarning ? (
              <Text style={styles.warning}>{tailnetWarning}</Text>
            ) : null}
            <Pressable
              style={[styles.primaryButton, saving && styles.buttonDisabled]}
              onPress={saveConnection}
              disabled={saving}
            >
              <Text style={styles.primaryButtonText}>
                {saving ? "Saving" : "Save Connection"}
              </Text>
            </Pressable>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.statsRow}>
            <Stat label="Agents" value={String(agents.length)} />
            <Stat label="Events" value={String(events.length)} />
          </View>

          <View style={styles.panel}>
            <Text style={styles.sectionTitle}>Runtime</Text>
            <View style={styles.chipRow}>
              {providers.map((provider) => (
                <Pressable
                  key={provider.id}
                  style={[
                    styles.chip,
                    selectedProviderId === provider.id && styles.chipActive,
                  ]}
                  onPress={() => {
                    setSelectedProviderId(provider.id);
                    setSelectedAgentId("");
                  }}
                >
                  <Text
                    style={[
                      styles.chipText,
                      selectedProviderId === provider.id &&
                        styles.chipTextActive,
                    ]}
                  >
                    {provider.id}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.chipRow}>
              {agents.map((agent) => (
                <Pressable
                  key={agent.id}
                  style={[
                    styles.chip,
                    selectedAgentId === agent.id && styles.chipActive,
                  ]}
                  onPress={() => setSelectedAgentId(agent.id)}
                >
                  <Text
                    style={[
                      styles.chipText,
                      selectedAgentId === agent.id && styles.chipTextActive,
                    ]}
                  >
                    {agent.displayName ?? agent.id}
                  </Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              value={agentInput}
              onChangeText={setAgentInput}
              multiline
              placeholder="Send input to selected agent"
              placeholderTextColor="#8a9099"
              style={[styles.input, styles.multilineInput]}
            />
            <Pressable
              style={[
                styles.primaryButton,
                (!selectedAgentId || !agentInput.trim()) &&
                  styles.buttonDisabled,
              ]}
              onPress={sendAgentInput}
              disabled={!selectedAgentId || !agentInput.trim()}
            >
              <Text style={styles.primaryButtonText}>Send Input</Text>
            </Pressable>
            <Text style={styles.outputText} numberOfLines={8}>
              {agentOutput || "No runtime output."}
            </Text>
          </View>

          <View style={styles.panel}>
            <Text style={styles.sectionTitle}>Room Message</Text>
            <TextInput
              value={messageBody}
              onChangeText={setMessageBody}
              multiline
              placeholder="Post to announcements"
              placeholderTextColor="#8a9099"
              style={[styles.input, styles.multilineInput]}
            />
            <Pressable
              style={[
                styles.secondaryButton,
                !messageBody.trim() && styles.buttonDisabled,
              ]}
              onPress={postRoomMessage}
              disabled={!messageBody.trim()}
            >
              <Text style={styles.secondaryButtonText}>Post Message</Text>
            </Pressable>
          </View>

          <View style={styles.panel}>
            <Text style={styles.sectionTitle}>Messages</Text>
            {messages.slice(0, 8).map((message) => (
              <View key={message.id} style={styles.messageRow}>
                <Text style={styles.rowMeta}>
                  #{message.channelId ?? "announcements"} - {message.sender.id}
                </Text>
                <Text style={styles.messageBody}>{message.body}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function StatusPill(props: { ok: boolean; loading: boolean }) {
  if (props.loading) {
    return (
      <View style={styles.statusPill}>
        <ActivityIndicator size="small" color="#f6f2e8" />
        <Text style={styles.statusText}>Syncing</Text>
      </View>
    );
  }
  return (
    <View
      style={[styles.statusPill, props.ok ? styles.okPill : styles.badPill]}
    >
      <Text style={styles.statusText}>{props.ok ? "Online" : "Offline"}</Text>
    </View>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{props.value}</Text>
      <Text style={styles.statLabel}>{props.label}</Text>
    </View>
  );
}

function formatError(error: unknown): string {
  if (error instanceof AgentRoomApiError) {
    if (error.status === 401) return "API token rejected or missing.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f6f2e8",
  },
  keyboard: {
    flex: 1,
  },
  content: {
    padding: 18,
    gap: 14,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  title: {
    color: "#18202a",
    fontSize: 32,
    fontWeight: "800",
  },
  subtitle: {
    color: "#59616c",
    fontSize: 14,
    marginTop: 2,
  },
  panel: {
    backgroundColor: "#ffffff",
    borderColor: "#d9d6cc",
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    gap: 10,
  },
  sectionTitle: {
    color: "#18202a",
    fontSize: 16,
    fontWeight: "800",
  },
  segmented: {
    flexDirection: "row",
    backgroundColor: "#edf0f2",
    borderRadius: 8,
    padding: 3,
  },
  segment: {
    flex: 1,
    borderRadius: 6,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentActive: {
    backgroundColor: "#18202a",
  },
  segmentText: {
    color: "#59616c",
    fontSize: 13,
    fontWeight: "700",
  },
  segmentTextActive: {
    color: "#ffffff",
  },
  input: {
    minHeight: 44,
    borderColor: "#c9d0d8",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#18202a",
    backgroundColor: "#fbfcfd",
    fontSize: 15,
  },
  multilineInput: {
    minHeight: 88,
    textAlignVertical: "top",
  },
  primaryButton: {
    minHeight: 46,
    borderRadius: 8,
    backgroundColor: "#1f6f8b",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800",
  },
  secondaryButton: {
    minHeight: 46,
    borderRadius: 8,
    backgroundColor: "#27313f",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  secondaryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800",
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  warning: {
    color: "#9a5d00",
    fontSize: 13,
  },
  error: {
    color: "#b42318",
    backgroundColor: "#fff1ef",
    borderColor: "#ffd0ca",
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
  },
  statsRow: {
    flexDirection: "row",
    gap: 10,
  },
  stat: {
    flex: 1,
    backgroundColor: "#18202a",
    borderRadius: 8,
    padding: 12,
  },
  statValue: {
    color: "#ffffff",
    fontSize: 24,
    fontWeight: "800",
  },
  statLabel: {
    color: "#b9c0c9",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 2,
  },
  statusPill: {
    minHeight: 34,
    borderRadius: 8,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#59616c",
  },
  okPill: {
    backgroundColor: "#24745b",
  },
  badPill: {
    backgroundColor: "#8f2d2d",
  },
  statusText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    borderRadius: 8,
    borderColor: "#c9d0d8",
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#ffffff",
  },
  chipActive: {
    backgroundColor: "#d9eef2",
    borderColor: "#1f6f8b",
  },
  chipText: {
    color: "#27313f",
    fontSize: 13,
    fontWeight: "700",
  },
  chipTextActive: {
    color: "#0f5268",
  },
  outputText: {
    color: "#26313d",
    backgroundColor: "#f4f7f8",
    borderRadius: 8,
    padding: 10,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
  },
  row: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    borderTopColor: "#ece8de",
    borderTopWidth: 1,
    paddingTop: 10,
    gap: 10,
  },
  rowMain: {
    flex: 1,
  },
  rowTitle: {
    color: "#18202a",
    fontSize: 15,
    fontWeight: "800",
  },
  rowMeta: {
    color: "#68717d",
    fontSize: 12,
    marginTop: 2,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  activeDot: {
    backgroundColor: "#1f6f8b",
  },
  doneDot: {
    backgroundColor: "#24745b",
  },
  blockedDot: {
    backgroundColor: "#b4542d",
  },
  messageRow: {
    borderTopColor: "#ece8de",
    borderTopWidth: 1,
    paddingTop: 10,
    gap: 3,
  },
  messageBody: {
    color: "#18202a",
    fontSize: 14,
    lineHeight: 20,
  },
  muted: {
    color: "#68717d",
    fontSize: 14,
  },
});
