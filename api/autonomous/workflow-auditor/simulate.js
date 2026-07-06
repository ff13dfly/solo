const fs = require('fs');
const path = require('path');
// Path to the shared agent modules
const agentModulesPath = path.resolve(__dirname, '../../node_modules');
const { GoogleGenerativeAI } = require(path.join(agentModulesPath, '@google/generative-ai'));
const dotenv = require(path.join(agentModulesPath, 'dotenv'));

dotenv.config({ path: path.resolve(__dirname, '../../core/agent/.env') });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const SYSTEM_PROMPT = `
You are the Solo Workflow Auditor AI. Your job is to analyze a JSON-based Workflow and categorize its risk level according to Solo's safety standards.

### RISK CATEGORIES:
1. AUTO_PASS: All steps are read-only operations (e.g., .list, .get, .query). No side effects.
2. ASSISTED_REVIEW: Contains low-risk write operations (e.g., creating/updating non-critical entities like commodities, labels). Requires human one-click confirmation.
3. MANUAL_REVIEW: High-risk or sensitive operations. This includes ERP writes, financial records (purchase, invoice), bulk operations, or cross-service write chains.
4. AUTO_REJECT: Contains forbidden patterns (method names not following service.entity.action, authority.* write attempts, potential loops, or suspicious structure).

### OUTPUT FORMAT:
Return a JSON object:
{
  "decision": "AUTO_PASS | ASSISTED_REVIEW | MANUAL_REVIEW | AUTO_REJECT",
  "reason": "Short explanation in Chinese",
  "risk_score": 0-100,
  "dangerous_steps": ["step_id1", "..."]
}
`;

async function runAudit(caseName) {
  const casePath = path.join(__dirname, 'cases', caseName);
  const workflowJson = fs.readFileSync(casePath, 'utf8');
  
  const prompt = `Workflow JSON:\n${workflowJson}\n\nPlease audit this.`;
  
  try {
    const result = await model.generateContent([SYSTEM_PROMPT, prompt]);
    const response = result.response.text();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    const auditResult = jsonMatch ? JSON.parse(jsonMatch[0]) : { decision: "ERROR", reason: response };
    
    console.log(`[Case: ${caseName}]`);
    console.log(`Decision: ${auditResult.decision}`);
    console.log(`Reason: ${auditResult.reason}`);
    console.log(`Risk Score: ${auditResult.risk_score}`);
    console.log(`---------------------------------------\n`);
  } catch (error) {
    console.error(`Error auditing ${caseName}:`, error.message);
  }
}

async function main() {
  console.log("--- Solo Autonomous: Workflow Auditor Simulation ---\n");
  const cases = fs.readdirSync(path.join(__dirname, 'cases')).filter(f => f.endsWith('.json'));
  
  for (const c of cases) {
    await runAudit(c);
  }
}

main();
