import {
  READ_RECEIPT_TARGET_LOOKUP_CALLER,
  readReceiptTargetLookupReadDiagnosticFields,
} from '../src/messages/readReceipt/readReceiptTargetLookupDiag';

describe('readReceiptTargetLookupReadDiagnosticFields', () => {
  it('includes messageId, userId, route/caller, flags, accessScope unknown, workerId, pid', () => {
    const d = readReceiptTargetLookupReadDiagnosticFields({
      messageId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'ffffffff-1111-2222-3333-444444444444',
      requestId: 'req-abc',
      includeCommunityId: true,
      preferCache: true,
      accessScope: 'unknown',
    });
    expect(d.caller).toBe(READ_RECEIPT_TARGET_LOOKUP_CALLER);
    expect(d.route).toBe(READ_RECEIPT_TARGET_LOOKUP_CALLER);
    expect(d.messageId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(d.userId).toBe('ffffffff-1111-2222-3333-444444444444');
    expect(d.requestId).toBe('req-abc');
    expect(d.includeCommunityId).toBe(true);
    expect(d.preferCache).toBe(true);
    expect(d.accessScope).toBe('unknown');
    expect(typeof d.workerId).toBe('string');
    expect(String(d.workerId).length).toBeGreaterThan(0);
    expect(typeof d.processPid).toBe('number');
  });

  it('omits requestId when absent', () => {
    const d = readReceiptTargetLookupReadDiagnosticFields({
      messageId: 'm1',
      userId: 'u1',
      includeCommunityId: false,
      preferCache: false,
      accessScope: 'unknown',
    });
    expect(d.requestId).toBeUndefined();
  });
});
