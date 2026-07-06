const fs = require('fs');
const path = require('path');
const { createSystemHandlers } = require('../handlers/system');

jest.mock('fs');

class MockResponse {
    constructor() { this.sentData = null; }
    json(data) { this.sentData = data; return this; }
}

describe('System Handlers', () => {

    let handlers;
    let mockAddService;

    beforeEach(() => {
        mockAddService = jest.fn();
        handlers = createSystemHandlers(mockAddService, null, '/mock/dir');
        jest.clearAllMocks();
    });

    describe('addService', () => {
        test('should call injected addService', async () => {
            mockAddService.mockResolvedValue({ serviceName: 's1' });
            const res = new MockResponse();
            await handlers.addService({ url: 'http://s1' }, 1, res);
            
            expect(mockAddService).toHaveBeenCalledWith('http://s1');
            expect(res.sentData.result.serviceName).toBe('s1');
        });

        test('should handle errors', async () => {
             mockAddService.mockRejectedValue(new Error('Fail'));
             const res = new MockResponse();
             await handlers.addService({ url: 'http://s1' }, 1, res);
             
             expect(res.sentData.error).toBeDefined();
             expect(res.sentData.error.message).toBe('Fail');
        });
    });

    describe('getLogs', () => {
        const LOG_FILE = 'Line1\nLine2\nLine3\nLine4\nLine5\n';

        test('should deny non-admin', () => {
             const res = new MockResponse();
             handlers.getLogs({}, 1, res, false);
             expect(res.sentData.error.code).toBe(-32604);
        });

        test('should return empty if log file missing', () => {
             fs.existsSync.mockReturnValue(false);
             const res = new MockResponse();
             handlers.getLogs({}, 1, res, true);
             expect(res.sentData.result.logs).toEqual([]);
             expect(res.sentData.result.total).toBe(0);
        });

        test('should return paginated logs', () => {
             fs.existsSync.mockReturnValue(true);
             fs.readFileSync.mockReturnValue(LOG_FILE);

             const res = new MockResponse();
             // Page 1, Size 2. Total 5 lines. 
             // Logic: start = max(0, 5 - 1*2) = 3. end = max(0, 5 - 0*2) = 5.
             // Slice(3, 5) -> Line4, Line5
             handlers.getLogs({ page: 1, pageSize: 2 }, 1, res, true);
             
             expect(res.sentData.result.total).toBe(5);
             expect(res.sentData.result.logs).toEqual(['Line4', 'Line5']);
             expect(res.sentData.result.pages).toBe(3); // ceil(5/2)
        });

        test('should handle reading errors', () => {
             fs.existsSync.mockReturnValue(true);
             fs.readFileSync.mockImplementation(() => { throw new Error('EACCES'); });
             
             const res = new MockResponse();
             handlers.getLogs({}, 1, res, true);
             
             expect(res.sentData.error).toBeDefined();
             expect(res.sentData.error.message).toContain('Failed to read logs');
        });
    });

});
