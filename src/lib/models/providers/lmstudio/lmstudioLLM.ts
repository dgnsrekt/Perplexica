import OpenAILLM from '../openai/openaiLLM';
import { GenerateObjectInput } from '../../types';
import { zodResponseFormat } from 'openai/helpers/zod';
import { repairJson } from '@toolsycc/json-repair';

class LMStudioLLM extends OpenAILLM {
  async generateObject<T>(input: GenerateObjectInput): Promise<T> {
    const response = await this.openAIClient.chat.completions.create({
      model: this.config.model,
      messages: this.convertToOpenAIMessages(input.messages),
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      response_format: zodResponseFormat(input.schema, 'object'),
    });

    if (response.choices && response.choices.length > 0) {
      const msg = response.choices[0].message as any;
      // Reasoning/thinking models (e.g. qwen3.5-35b-a3b) put structured
      // output into reasoning_content when content is empty
      const raw: string = msg.content || msg.reasoning_content || '';
      try {
        return input.schema.parse(
          JSON.parse(
            repairJson(raw, { extractJson: true }) as string,
          ),
        ) as T;
      } catch (err) {
        throw new Error(`Error parsing response from LM Studio: ${err}`);
      }
    }

    throw new Error('No response from LM Studio');
  }
}

export default LMStudioLLM;
