const fs = require('fs');
const path = require('path');

// Helper to format date YYYYMMDDHHmm
function getTimestamp() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return `${yyyy}${mm}${dd}${hh}${min}`;
}

class MarkdownReporter {
    constructor(globalConfig, options) {
        this._globalConfig = globalConfig;
        this._options = options;
    }

    onRunComplete(contexts, results) {
        console.log('Generating Markdown Report...');

        const timestamp = getTimestamp();
        // Ensure report directory exists
        const reportDir = path.join(__dirname, `../report`);
        if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true });
        }
        const reportPath = path.join(reportDir, `${timestamp}.md`);
        
        const total = results.numTotalTests;
        const passed = results.numPassedTests;
        const failed = results.numFailedTests;
        const pending = results.numPendingTests;
        const duration = (Date.now() - results.startTime) / 1000;
        const status = failed > 0 ? '❌ FAILED' : '✅ PASSED';

        let md = `# Test Execution Report\n\n`;
        md += `**Timestamp**: ${new Date().toISOString()}\n`;
        md += `**Duration**: ${duration.toFixed(2)}s\n`;
        md += `**Status**: ${status}\n\n`;

        md += `## 1. Summary\n`;
        md += `| Total | Passed | Failed | Skipped |\n`;
        md += `| :---: | :---: | :---: | :---: |\n`;
        md += `| ${total} | ${passed} | ${failed} | ${pending} |\n\n`;

        // Aggregation by Category (YAML file)
        const categories = {};
        
        results.testResults.forEach(suite => {
            suite.testResults.forEach(test => {
                // ancestorTitles: ["Asset Service YAML Tests", "unit.yaml"]
                // We want the last ancestor as the Category Name, or default to Suite Name
                let catName = test.ancestorTitles.length > 0 
                    ? test.ancestorTitles[test.ancestorTitles.length - 1] 
                    : path.basename(suite.testFilePath);

                if (!categories[catName]) {
                    categories[catName] = { total: 0, passed: 0, failed: 0, pending: 0 };
                }
                
                categories[catName].total++;
                if (test.status === 'passed') categories[catName].passed++;
                if (test.status === 'failed') categories[catName].failed++;
                if (test.status === 'pending') categories[catName].pending++;
            });
        });

        md += `## 2. Categories Breakdown\n`;
        md += `| Category | Total | Passed | Failed | Skipped |\n`;
        md += `| :--- | :---: | :---: | :---: | :---: |\n`;
        
        for (const [name, stats] of Object.entries(categories)) {
            md += `| **${name}** | ${stats.total} | ${stats.passed} | ${stats.failed} | ${stats.pending} |\n`;
        }
        md += `\n`;

        if (failed > 0) {
            md += `## 3. Failed Cases Details\n`;
            md += `| Suite | Category | Case | Error |\n`;
            md += `| :--- | :--- | :--- | :--- |\n`;
            
            results.testResults.forEach(suite => {
                 suite.testResults.forEach(test => {
                     if (test.status === 'failed') {
                         const suiteName = path.basename(suite.testFilePath);
                         const catName = test.ancestorTitles.length > 0 
                            ? test.ancestorTitles[test.ancestorTitles.length - 1] 
                            : suiteName;
                         const caseName = test.title;
                         let errorMsg = test.failureMessages[0] ? test.failureMessages[0].split('\n')[0] : 'Unknown';
                         errorMsg = errorMsg.replace(/\|/g, '\\|'); 
                         md += `| ${suiteName} | ${catName} | ${caseName} | ${errorMsg} |\n`;
                     }
                 });
            });
            md += `\n`;
        }

        md += `## 4. Suites Breakdown\n`;
        md += `| Suite | Total | Passed | Failed | Duration (ms) |\n`;
        md += `| :--- | :---: | :---: | :---: | :---: |\n`;

        results.testResults.forEach(suite => {
            const suiteName = path.basename(suite.testFilePath);
            const sTotal = suite.testResults.length;
            const sPassed = suite.testResults.filter(t => t.status === 'passed').length;
            const sFailed = suite.testResults.filter(t => t.status === 'failed').length;
            const sDuration = suite.perfStats.end - suite.perfStats.start;
            
            md += `| ${suiteName} | ${sTotal} | ${sPassed} | ${sFailed} | ${sDuration} |\n`;
        });

        fs.writeFileSync(reportPath, md);
        console.log(`Report generated at: ${reportPath}`);
    }
}

module.exports = MarkdownReporter;
