// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  conversationPassthroughTargetsForPublish,
} = require('../src/messages/conversationPassthroughFilter') as {
  conversationPassthroughTargetsForPublish: (
    event: string,
    passthroughTargets: string[],
    userIds: string[],
  ) => string[];
};

describe('conversationPassthroughTargetsForPublish', () => {
  const prevCanonical = process.env.REALTIME_CANONICAL_USER_FEED;
  const prevSkip = process.env.REALTIME_SKIP_CONVERSATION_TOPIC_FOR_MESSAGE_CREATED;

  afterEach(() => {
    process.env.REALTIME_CANONICAL_USER_FEED = prevCanonical;
    process.env.REALTIME_SKIP_CONVERSATION_TOPIC_FOR_MESSAGE_CREATED = prevSkip;
  });

  it('leaves passthrough unchanged by default (skip env off)', () => {
    delete process.env.REALTIME_SKIP_CONVERSATION_TOPIC_FOR_MESSAGE_CREATED;
    const targets = ['conversation:c1', 'community:x'];
    expect(
      conversationPassthroughTargetsForPublish('message:created', targets, ['u1']),
    ).toEqual(targets);
  });

  it('strips conversation: for message:created when skip + canonical enabled', () => {
    process.env.REALTIME_CANONICAL_USER_FEED = 'true';
    process.env.REALTIME_SKIP_CONVERSATION_TOPIC_FOR_MESSAGE_CREATED = 'true';
    const targets = ['conversation:c1', 'community:x'];
    expect(
      conversationPassthroughTargetsForPublish('message:created', targets, ['u1']),
    ).toEqual(['community:x']);
  });

  it('does not strip for other events', () => {
    process.env.REALTIME_CANONICAL_USER_FEED = 'true';
    process.env.REALTIME_SKIP_CONVERSATION_TOPIC_FOR_MESSAGE_CREATED = 'true';
    const targets = ['conversation:c1'];
    expect(
      conversationPassthroughTargetsForPublish('conversation:participant_added', targets, ['u1']),
    ).toEqual(targets);
  });

  it('does not strip when no user ids (safety)', () => {
    process.env.REALTIME_CANONICAL_USER_FEED = 'true';
    process.env.REALTIME_SKIP_CONVERSATION_TOPIC_FOR_MESSAGE_CREATED = 'true';
    const targets = ['conversation:c1'];
    expect(conversationPassthroughTargetsForPublish('message:created', targets, [])).toEqual(targets);
  });
});
