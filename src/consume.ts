import { createMessageAssembler, type AssemblerEvent, type MessageAssemblerOptions, type MessageState } from "./core/assembler.js";
import { normalizeAIStream, type AIStreamSource, type NormalizeStreamOptions } from "./normalize-stream.js";
import { throwIfAborted } from "./abort.js";

type EventOf<T extends AssemblerEvent["type"]> = Extract<AssemblerEvent, { type: T }>;
type Handler<T> = (event: T) => void | Promise<void>;

export interface ConsumeHandlers {
  event?: Handler<AssemblerEvent>;
  text?: Handler<EventOf<"text">>;
  toolInput?: Handler<EventOf<"tool-input">>;
  toolCall?: Handler<EventOf<"tool-call">>;
  toolCallComplete?: Handler<EventOf<"tool-call-complete">>;
  toolInputError?: Handler<EventOf<"tool-input-error">>;
  reset?: Handler<EventOf<"reset">>;
  control?: Handler<EventOf<"control">>;
}

export interface ConsumeOptions {
  normalize?: NormalizeStreamOptions;
  assembler?: MessageAssemblerOptions;
}

/** Consume one source in order. Handlers are awaited before reading the next part. */
export async function consume(
  source: AIStreamSource,
  handlers: ConsumeHandlers = {},
  options: ConsumeOptions = {},
): Promise<MessageState> {
  const assembler = createMessageAssembler(options.assembler);
  async function dispatch(events: AssemblerEvent[]): Promise<void> {
    for (const event of events) {
      throwIfAborted(options.normalize?.signal);
      await handlers.event?.(event);
      throwIfAborted(options.normalize?.signal);
      switch (event.type) {
        case "text": await handlers.text?.(event); break;
        case "tool-input": await handlers.toolInput?.(event); break;
        case "tool-call": await handlers.toolCall?.(event); break;
        case "tool-call-complete": await handlers.toolCallComplete?.(event); break;
        case "tool-input-error": await handlers.toolInputError?.(event); break;
        case "reset": await handlers.reset?.(event); break;
        case "control": await handlers.control?.(event); break;
      }
      throwIfAborted(options.normalize?.signal);
    }
  }
  try {
    for await (const part of normalizeAIStream(source, options.normalize)) {
      throwIfAborted(options.normalize?.signal);
      await dispatch(assembler.push(part));
    }
    throwIfAborted(options.normalize?.signal);
    await dispatch(assembler.finish());
    return assembler.state;
  } catch (error) {
    assembler.cancel();
    throw error;
  }
}
