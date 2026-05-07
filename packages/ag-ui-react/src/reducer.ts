/**
 * ag-ui-react reducer — Pure function that applies ThreadAgentEvents to ChatMessage[].
 *
 * This is the core state machine that drives the chat UI. It is framework-agnostic
 * (no React imports) so it can be tested independently and used in any context.
 *
 * @packageDocumentation
 */

import type { ChatMessage, ThreadAgentEvent } from "./types.js";

/**
 * Ensure an assistant message with the given ID exists in the array.
 * If it doesn't exist, create a placeholder. If it does, mark it as streaming.
 */
function ensureAssistantMessage(
  messages: ChatMessage[],
  messageId: string,
  metadata: Partial<
    Pick<
      ChatMessage,
      | "stepId"
      | "parentStepId"
      | "stepKind"
      | "stepName"
      | "parentStepName"
      | "agentId"
      | "agentName"
    >
  > = {},
): ChatMessage[] {
  const existing = messages.find((m) => m.id === messageId);
  if (existing) {
    return messages.map((m) =>
      m.id === messageId
        ? {
            ...m,
            role: "assistant" as const,
            isStreaming: true,
            stepId: m.stepId ?? metadata.stepId,
            parentStepId: m.parentStepId ?? metadata.parentStepId,
            stepKind: m.stepKind ?? metadata.stepKind,
            stepName: m.stepName ?? metadata.stepName,
            parentStepName: m.parentStepName ?? metadata.parentStepName,
            agentId: m.agentId ?? metadata.agentId,
            agentName: m.agentName ?? metadata.agentName,
          }
        : m,
    );
  }

  return [
    ...messages,
    {
      id: messageId,
      role: "assistant" as const,
      content: "",
      toolCalls: [],
      isStreaming: true,
      ...metadata,
      createdAt: new Date().toISOString(),
    },
  ];
}

function ensureToolResultMessage(
  messages: ChatMessage[],
  messageId: string,
  toolCallId: string,
  metadata: Partial<
    Pick<
      ChatMessage,
      | "stepId"
      | "parentStepId"
      | "stepKind"
      | "stepName"
      | "parentStepName"
      | "agentId"
      | "agentName"
    >
  > = {},
): ChatMessage[] {
  const existing = messages.find((m) => m.id === messageId);
  if (existing) {
    return messages.map((m) =>
      m.id === messageId
        ? {
            ...m,
            role: "tool" as const,
            toolCallId,
            isStreaming: true,
            stepId: m.stepId ?? metadata.stepId,
            parentStepId: m.parentStepId ?? metadata.parentStepId,
            stepKind: m.stepKind ?? metadata.stepKind,
            stepName: m.stepName ?? metadata.stepName,
            parentStepName: m.parentStepName ?? metadata.parentStepName,
            agentId: m.agentId ?? metadata.agentId,
            agentName: m.agentName ?? metadata.agentName,
          }
        : m,
    );
  }

  return [
    ...messages,
    {
      id: messageId,
      role: "tool" as const,
      content: "",
      toolCallId,
      isStreaming: true,
      ...metadata,
      createdAt: new Date().toISOString(),
    },
  ];
}

/**
 * Apply a single ThreadAgentEvent to the current message list, returning
 * a new immutable array. This is a pure reducer — no side effects.
 *
 * Event handling:
 * - `append_message`: Adds a new message; marks the parent tool call as complete
 * - `assistant_start`: Creates or updates an assistant message placeholder
 * - `assistant_delta`: Appends text content to the streaming assistant message
 * - `assistant_end`: Clears the streaming flag on the assistant message
 * - `tool_start`: Adds a tool call entry to the parent assistant message
 * - `tool_args`: Appends argument delta to the tool call
 * - `tool_end`: Marks the tool call as complete; updates message streaming state
 * - `step_started` / `step_finished`: No-op for messages (handled by step state)
 * - `run_complete`: Clears all streaming flags
 */
export function updateMessagesWithAgentEvent(
  messages: ChatMessage[],
  event: ThreadAgentEvent,
): ChatMessage[] {
  switch (event.type) {
    case "append_message": {
      const existingMessage = messages.find((m) => m.id === event.message.id);
      if (existingMessage) {
        if (event.message.role !== "tool") {
          return messages;
        }

        return messages.map((m) =>
          m.id === event.message.id
            ? {
                ...m,
                ...event.message,
                role: "tool" as const,
                isStreaming: false,
                content:
                  event.message.content.length > 0
                    ? event.message.content
                    : m.content,
              }
            : m,
        );
      }
      return [
        // Mark parent tool call as complete when its result arrives
        ...messages.map((m) => {
          if (
            event.message.role !== "tool" ||
            !event.message.toolCallId ||
            !m.toolCalls?.some((tc) => tc.id === event.message.toolCallId)
          ) {
            return m;
          }

          return {
            ...m,
            toolCalls: m.toolCalls!.map((tc) =>
              tc.id === event.message.toolCallId
                ? { ...tc, complete: true }
                : tc,
            ),
          };
        }),
        event.message,
      ];
    }

    case "assistant_start":
      return ensureAssistantMessage(messages, event.messageId, {
        stepId: event.stepId,
        parentStepId: event.parentStepId,
        stepKind: event.stepKind,
        stepName: event.stepName,
        parentStepName: event.parentStepName,
        agentId: event.agentId,
        agentName: event.agentName,
      });

    case "assistant_delta":
      return ensureAssistantMessage(messages, event.messageId, {
        agentId: event.agentId,
        agentName: event.agentName,
      }).map((m) =>
        m.id === event.messageId
          ? {
              ...m,
              content: `${m.content}${event.delta}`,
              isStreaming: true,
            }
          : m,
      );

    case "assistant_end":
      return messages.map((m) =>
        m.id === event.messageId ? { ...m, isStreaming: false } : m,
      );

    case "tool_start": {
      return ensureAssistantMessage(messages, event.parentMessageId, {
        stepId: event.stepId,
        parentStepId: event.parentStepId,
        stepKind: event.stepKind,
        stepName: event.stepName,
        parentStepName: event.parentStepName,
        agentId: event.agentId,
        agentName: event.agentName,
      }).map((m) => {
        if (m.id !== event.parentMessageId) return m;
        // Don't add duplicate tool call
        if (m.toolCalls?.some((tc) => tc.id === event.toolCallId)) return m;

        return {
          ...m,
          toolCalls: [
            ...(m.toolCalls || []),
            {
              id: event.toolCallId,
              type: "function" as const,
              function: {
                name: event.toolCallName,
                arguments: "",
              },
              complete: false,
              stepId: event.stepId,
              parentStepId: event.parentStepId,
              stepKind: event.stepKind,
              stepName: event.stepName,
              parentStepName: event.parentStepName,
              agentId: event.agentId,
              agentName: event.agentName,
            },
          ],
        };
      });
    }

    case "tool_args":
      return messages.map((m) => {
        if (!m.toolCalls?.some((tc) => tc.id === event.toolCallId)) return m;

        return {
          ...m,
          toolCalls: m.toolCalls!.map((tc) =>
            tc.id === event.toolCallId
              ? {
                  ...tc,
                  function: {
                    ...tc.function,
                    arguments: `${tc.function.arguments}${event.delta}`,
                  },
                }
              : tc,
          ),
        };
      });

    case "tool_end":
      return messages.map((m) => {
        if (!m.toolCalls?.some((tc) => tc.id === event.toolCallId)) return m;

        const toolCalls = m.toolCalls!.map((tc) =>
          tc.id === event.toolCallId ? { ...tc, complete: true } : tc,
        );

        return {
          ...m,
          toolCalls,
          // Only keep streaming if there are still incomplete tool calls
          isStreaming: toolCalls.some((tc) => !tc.complete),
        };
      });

    case "tool_result_start":
      return ensureToolResultMessage(messages, event.messageId, event.toolCallId, {
        stepId: event.stepId,
        parentStepId: event.parentStepId,
        stepKind: event.stepKind,
        stepName: event.stepName,
        parentStepName: event.parentStepName,
        agentId: event.agentId,
        agentName: event.agentName,
      });

    case "tool_result_delta":
      return ensureToolResultMessage(
        messages,
        event.messageId,
        event.toolCallId,
      ).map((m) =>
        m.id === event.messageId
          ? {
              ...m,
              content: `${m.content}${event.delta}`,
              isStreaming: true,
            }
          : m,
      );

    case "tool_result_end":
      return messages.map((m) =>
        m.id === event.messageId && m.toolCallId === event.toolCallId
          ? { ...m, isStreaming: false }
          : m,
      );

    // Step events don't affect messages — handled separately via activeSteps
    case "step_started":
    case "step_finished":
      return messages;

    case "reasoning_start":
      return ensureAssistantMessage(messages, event.messageId, {
        stepId: event.stepId,
        parentStepId: event.parentStepId,
        stepKind: event.stepKind,
        stepName: event.stepName,
        parentStepName: event.parentStepName,
        agentId: event.agentId,
        agentName: event.agentName,
      }).map((m) =>
        m.id === event.messageId
          ? {
              ...m,
              reasoning: m.reasoning ?? "",
              isReasoningStreaming: true,
            }
          : m,
      );

    case "reasoning_delta":
      return ensureAssistantMessage(messages, event.messageId, {
        agentId: event.agentId,
        agentName: event.agentName,
      }).map((m) =>
        m.id === event.messageId
          ? {
              ...m,
              reasoning: `${m.reasoning ?? ""}${event.delta}`,
              isReasoningStreaming: true,
            }
          : m,
      );

    case "reasoning_end":
      return messages.map((m) =>
        m.id === event.messageId
          ? { ...m, isReasoningStreaming: false }
          : m,
      );

    case "run_complete":
      return messages.map((m) =>
        m.isStreaming || m.isReasoningStreaming
          ? { ...m, isStreaming: false, isReasoningStreaming: false }
          : m,
      );
  }
}
