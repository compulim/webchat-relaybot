// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
  Activity,
  ActivityHandler,
  BotFrameworkAdapter,
  ConversationReference,
  MessageFactory,
  TurnContext
} from 'botbuilder';
import fetch from 'node-fetch';
import decode from 'jwt-decode';

const DIRECT_LINE_POLL_INTERVAL = 1000;
const IDLE_DURATION = 300_000;
const MAXIMUM_SESSION_DURATION = 3_600_000;

function cleanActivity(activity: Partial<Activity>): Partial<Activity> {
  return {
    ...activity,
    channelId: undefined,
    conversation: undefined,
    from: undefined,
    id: undefined,
    recipient: undefined,
    serviceUrl: undefined,
    timestamp: undefined
  };
}

const submitDirectLineTokenCardAttachment = {
  content: {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        size: 'large',
        weight: 'bolder',
        text: 'Relay to Direct Line bot',
        horizontalAlignment: 'left',
        wrap: true,
        style: 'heading'
      },
      {
        type: 'TextBlock',
        text: 'Please enter the Direct Line token of the bot to talk to, then click "Start conversation" button to start.',
        wrap: true
      },
      {
        isSubtle: true,
        size: 'Small',
        text: 'Tips: You can also send the token as a message.',
        type: 'TextBlock',
        wrap: true
      },
      {
        type: 'Input.Text',
        id: 'token',
        label: 'Direct Line token',
        isMultiline: true,
        isRequired: true,
        errorMessage: 'Token is required',
        style: 'Password',
        value: process.env.RELAY_DIRECT_LINE_TOKEN
      }
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: 'Start conversation',
        data: {
          id: 'StartConversation'
        }
      }
    ]
  },
  contentType: 'application/vnd.microsoft.card.adaptive'
};

export default class EchoBot extends ActivityHandler {
  constructor() {
    super();

    // See https://aka.ms/about-bot-activity-message to learn more about the message and other activity types.
    this.onMessage(async (context, next) => {
      const reference = (this.#reference = TurnContext.getConversationReference(context.activity));

      if (context.activity?.value?.id === 'StartConversation') {
        this.#abortController?.abort?.();
        this.start(context.activity.value.token);
      } else if (context.activity.type === 'message' && (context.activity.text || '').startsWith('eyJhb')) {
        this.#abortController?.abort?.();
        this.start(context.activity.text);
      } else if (!this.#relayDirectLineToken) {
        await context.sendActivity(MessageFactory.attachment(submitDirectLineTokenCardAttachment));
      } else {
        console.log(
          `Received a "${context.activity.type}" activity.\n\n${JSON.stringify(
            { activity: context.activity },
            null,
            2
          )}`
        );

        (async () => {
          try {
            await this.relayActivity(cleanActivity(context.activity));
          } catch (error) {
            console.error(error);

            await this.#adapter?.continueConversation(reference, async context => {
              await context.sendActivity(
                MessageFactory.text(`Failed to relay message to the bot.\n\n${error.message}`)
              );
            });
          }
        })();
      }

      // By calling next() you ensure that the next BotHandler is run.
      await next();
    });

    this.onMembersAdded(async (context, next) => {
      const membersAdded = context.activity.membersAdded || [];

      this.#reference = TurnContext.getConversationReference(context.activity);

      for (let cnt = 0; cnt < membersAdded.length; ++cnt) {
        if (membersAdded[cnt].id !== context.activity.recipient.id) {
          await context.sendActivity(MessageFactory.attachment(submitDirectLineTokenCardAttachment));
        }
      }

      // By calling next() you ensure that the next BotHandler is run.
      await next();
    });

    this.onEndOfConversation(async (_, next) => {
      this.#abortController?.abort?.();

      await next();
    });

    this.#adapter = new BotFrameworkAdapter({
      appId: process.env.MicrosoftAppId,
      appPassword: process.env.MicrosoftAppPassword
    });
  }

  #abortController: AbortController = new AbortController();
  #adapter: BotFrameworkAdapter | undefined;
  #relayBotId: string;
  #relayConversationId: string;
  #relayDirectLineToken: string;
  #reference: Partial<ConversationReference>;

  close() {
    this.#abortController.abort();
  }

  get relayBotId(): string {
    return this.#relayBotId;
  }

  get relayConversationId(): string {
    return this.#relayConversationId;
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  async relayActivity(activity: Partial<Activity>): Promise<void> {
    const res = await fetch(
      `https://directline.botframework.com/v3/directline/conversations/${this.relayConversationId}/activities`,
      {
        body: JSON.stringify(cleanActivity(activity)),
        headers: {
          Authorization: `Bearer ${this.#relayDirectLineToken}`,
          'Content-Type': 'application/json; charset=utf-8'
        },
        method: 'POST'
      }
    );

    if (!res.ok) {
      throw new Error(`Server returned ${res.status} "${res.statusText}" while relaying message to the bot.`);
    }

    await res.text();
  }

  async createConversation(): Promise<void> {
    const res = await fetch(`https://directline.botframework.com/v3/directline/conversations`, {
      headers: {
        Authorization: `Bearer ${this.#relayDirectLineToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      method: 'POST'
    });

    if (!res.ok) {
      throw new Error(`Server returned ${res.status} "${res.statusText}" while creating conversation.`);
    }

    await res.text();
  }

  async start(relayDirectLineToken: string) {
    const abortController = new AbortController();
    const { signal } = abortController;

    let idleTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
    const resetIdleTimeout = () => {
      idleTimeout && clearTimeout(idleTimeout);
      idleTimeout = setTimeout(async () => {
        await this.#adapter?.continueConversation(this.#reference, async context => {
          await context.sendActivity(MessageFactory.text('Idle timeout.'));
        });

        abortController.abort();
      }, IDLE_DURATION);
    };

    this.#abortController = abortController;

    try {
      let watermark: number | undefined;

      this.#relayDirectLineToken = relayDirectLineToken;

      const jsonWebToken = decode(relayDirectLineToken) as { bot: string; conv: string };

      this.#relayBotId = jsonWebToken.bot;
      this.#relayConversationId = jsonWebToken.conv;

      await this.createConversation();

      console.log(`Relay started for conversation ID "${this.relayConversationId}".`);

      await this.#adapter?.continueConversation(this.#reference, async context => {
        await context.sendActivity({
          text: `Relay started for conversation ID "${this.relayConversationId}".`,
          type: 'message'
        });
      });

      for (const startTime = Date.now(); !signal.aborted && Date.now() < startTime + MAXIMUM_SESSION_DURATION; ) {
        const url = `https://directline.botframework.com/v3/directline/conversations/${
          this.relayConversationId
        }/activities?watermark=${typeof watermark === 'undefined' ? '' : watermark}`;

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.#relayDirectLineToken}` },
          signal
        });

        if (!res.ok) {
          throw new Error(`Server returned ${res.status} "${res.statusText}".`);
        }

        const { activities, watermark: nextWatermark } = (await res.json()) as {
          activities: Activity[];
          watermark: number | undefined;
        };

        watermark = nextWatermark;

        activities?.length && console.log(JSON.stringify({ activities, watermark: nextWatermark }, null, 2));

        if (signal.aborted) {
          break;
        }

        await this.#adapter?.continueConversation(this.#reference, async context => {
          if (signal.aborted) {
            return;
          }

          await context.sendActivities(
            activities.filter(({ from: { id, role } }) => id === this.relayBotId || role === 'bot').map(cleanActivity)
          );

          resetIdleTimeout();
        });

        await new Promise(resolve => setTimeout(resolve, DIRECT_LINE_POLL_INTERVAL));
      }

      await this.#adapter?.continueConversation(this.#reference, async context => {
        await context.sendActivity(MessageFactory.text('Maximum duration exceeded.'));
      });
    } catch (error) {
      console.error(error);

      try {
        await this.#adapter?.continueConversation(this.#reference, async context => {
          await context.sendActivity({
            text: `Failed to relay message.\n\n\`\`\`json\n${JSON.stringify(
              {
                message: error.message
              },
              null,
              2
            )}\n\`\`\`\n`,
            type: 'message'
          });
        });
      } catch (error) {}

      abortController.abort();
    } finally {
      idleTimeout && clearTimeout(idleTimeout);

      try {
        await this.#adapter?.continueConversation(this.#reference, async context => {
          await context.sendActivity({
            text: `Conversation is closed.`,
            type: 'message'
          });
        });
      } catch (error) {}
    }
  }
}
