import type { ThoughtRecord, ThinkingAnalysis } from './types.js';

export class ThinkingAnalyzer {
  analyzeThoughts(thoughts: ThoughtRecord[]): ThinkingAnalysis {
    if (thoughts.length === 0) {
      return {
        totalThoughts: 0,
        averageThoughtLength: 0,
        revisions: 0,
        branches: 0,
        gaps: [],
        assumptions: [],
        suggestions: [],
        qualityScore: 0
      };
    }
    
    const totalThoughts = thoughts.length;
    const averageThoughtLength = thoughts.reduce((sum, t) => sum + t.thought_text.length, 0) / totalThoughts;
    const revisions = thoughts.filter(t => t.is_revision).length;
    const branches = new Set(thoughts.filter(t => t.branch_id).map(t => t.branch_id)).size;
    
    // Detect gaps
    const gaps = this.detectGaps(thoughts);
    
    // Find assumptions
    const assumptions = this.findAssumptions(thoughts);
    
    // Generate suggestions
    const suggestions = this.generateSuggestions(thoughts, gaps, assumptions);
    
    // Calculate quality score
    const qualityScore = this.calculateQualityScore(thoughts, revisions, branches, gaps.length, assumptions.length);
    
    return {
      totalThoughts,
      averageThoughtLength: Math.round(averageThoughtLength),
      revisions,
      branches,
      gaps,
      assumptions,
      suggestions,
      qualityScore
    };
  }
  
  private detectGaps(thoughts: ThoughtRecord[]): string[] {
    const gaps: string[] = [];
    const thoughtText = thoughts.map(t => t.thought_text.toLowerCase()).join(' ');
    
    // Common gap patterns
    const gapPatterns = [
      { pattern: /(?:haven'?t|didn'?t|not|missing|lack|absence).*?(?:explor|consider|analyz|discuss|address|cover)/gi, message: 'Missing exploration of key aspects' },
      { pattern: /(?:should|need|must|ought).*?(?:consider|explore|analyze|investigate|examine)/gi, message: 'Identified areas needing more consideration' },
      { pattern: /(?:but|however|although).*?(?:not|never|no|without)/gi, message: 'Potential contradictions or missing context' }
    ];
    
    // Check for common missing topics
    const commonTopics = [
      { keywords: ['performance', 'speed', 'optimization'], check: 'performance considerations' },
      { keywords: ['security', 'vulnerability', 'risk'], check: 'security implications' },
      { keywords: ['cost', 'price', 'budget', 'expense'], check: 'cost analysis' },
      { keywords: ['scalability', 'scale', 'growth'], check: 'scalability considerations' },
      { keywords: ['maintenance', 'maintain', 'support'], check: 'maintenance requirements' },
      { keywords: ['alternative', 'option', 'approach'], check: 'alternative approaches' }
    ];
    
    for (const topic of commonTopics) {
      const hasKeywords = topic.keywords.some(kw => thoughtText.includes(kw));
      if (!hasKeywords && thoughts.length > 2) {
        gaps.push(`Consider ${topic.check}`);
      }
    }
    
    return gaps;
  }
  
  private findAssumptions(thoughts: ThoughtRecord[]): string[] {
    const assumptions: string[] = [];
    const thoughtText = thoughts.map(t => t.thought_text.toLowerCase()).join(' ');
    
    // Common assumption patterns
    const assumptionPatterns = [
      /(?:assum|presum|suppos|believ|think|expect).*?(?:that|this|it|we|they)/gi,
      /(?:if|when|assuming|given that|supposing).*?(?:then|we|it|they)/gi
    ];
    
    // Look for unstated assumptions
    const unstatedAssumptions = [
      { pattern: /more.*?better/gi, message: 'Assumption that more is always better' },
      { pattern: /always|never|all|every/gi, message: 'Absolute statements that may be assumptions' },
      { pattern: /should|must|need to/gi, message: 'Prescriptive statements that may be assumptions' }
    ];
    
    for (const assumption of unstatedAssumptions) {
      if (assumption.pattern.test(thoughtText)) {
        assumptions.push(assumption.message);
      }
    }
    
    return assumptions;
  }
  
  private generateSuggestions(thoughts: ThoughtRecord[], gaps: string[], assumptions: string[]): string[] {
    const suggestions: string[] = [];
    
    // If gaps detected, suggest exploring them
    if (gaps.length > 0) {
      suggestions.push(`Explore the identified gaps: ${gaps.slice(0, 2).join(', ')}`);
    }
    
    // If assumptions found, suggest questioning them
    if (assumptions.length > 0) {
      suggestions.push(`Question the assumptions: ${assumptions.slice(0, 2).join(', ')}`);
    }
    
    // General suggestions based on thought count
    if (thoughts.length < 3) {
      suggestions.push('Consider breaking down the problem into more detailed steps');
    }
    
    if (thoughts.length > 0 && !thoughts.some(t => t.is_revision)) {
      suggestions.push('Consider revising earlier thoughts if new insights emerge');
    }
    
    if (thoughts.length > 0 && !thoughts.some(t => t.branch_id)) {
      suggestions.push('Explore alternative approaches or perspectives');
    }
    
    // Check if final thought
    const lastThought = thoughts[thoughts.length - 1];
    if (lastThought && !lastThought.next_thought_needed) {
      suggestions.push('Synthesize all insights into a comprehensive conclusion');
    }
    
    return suggestions;
  }
  
  private calculateQualityScore(
    thoughts: ThoughtRecord[],
    revisions: number,
    branches: number,
    gapsCount: number,
    assumptionsCount: number
  ): number {
    if (thoughts.length === 0) return 0;
    
    let score = 0.5; // Base score
    
    // More thoughts = better (up to a point)
    if (thoughts.length >= 3) score += 0.1;
    if (thoughts.length >= 5) score += 0.1;
    
    // Revisions show critical thinking
    if (revisions > 0) score += 0.1;
    
    // Branches show exploration
    if (branches > 0) score += 0.1;
    
    // Penalize for gaps and assumptions (but not too much - they're normal)
    score -= (gapsCount * 0.05);
    score -= (assumptionsCount * 0.03);
    
    // Average thought length (too short = rushed, too long = unfocused)
    const avgLength = thoughts.reduce((sum, t) => sum + t.thought_text.length, 0) / thoughts.length;
    if (avgLength >= 100 && avgLength <= 500) score += 0.1;
    if (avgLength < 50) score -= 0.1;
    
    // Ensure score is between 0 and 1
    return Math.max(0, Math.min(1, score));
  }
}

