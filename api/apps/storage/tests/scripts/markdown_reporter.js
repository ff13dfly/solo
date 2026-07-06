const fs = require('fs');
const path = require('path');

function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace(/[-:T.]/g, '').slice(0, 12); // YYYYMMDDHHmm
}

class MarkdownReporter {
    constructor(globalConfig, options) {
        this._globalConfig = globalConfig;
        this._options = options;
    }

    onRunComplete(contexts, results) {
        console.log('Generating Markdown Report...');

        const timestamp = getTimestamp();
        const reportDir = path.join(__dirname, `../report`);
        if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
        
        const reportPath = path.join(reportDir, `${timestamp}.md`);
        
        const total = results.numTotalTests;
        const passed = results.numPassedTests;
        const failed = results.numFailedTests;
        const duration = (Date.now() - results.startTime) / 1000;
        const status = failed > 0 ? '❌ FAILED' : '✅ PASSED';

        let md = `# Test Execution Report\n\n`;
        md += `**Timestamp**: ${new Date().toISOString()}\n`;
        md += `**Duration**: ${duration.toFixed(2)}s\n`;
        md += `**Status**: ${status}\n\n`;
        md += `| Total | Passed | Failed |\n| :---: | :---: | :---: |\n| ${total} | ${passed} | ${failed} |\n\n`;

        if (failed > 0) {
            md += `## Failed Cases\n\n`;
            results.testResults.forEach(suite => {
                 suite.testResults.forEach(test => {
                     if (test.status === 'failed') {
                         md += `### ${test.title}\n`;
                         md += `\`\`\`\n${test.failureMessages[0]}\n\`\`\`\n`;
                     }
                 });
            });
        }

        fs.writeFileSync(reportPath, md);
        console.log(`Report generated at: ${reportPath}`);
    }
}

module.exports = MarkdownReporter;
