-- Brain Trust 4 Frontend Integration - Intent System Migration
-- Adds intent support to existing tools and creates intent management tables

-- Add intent column to existing tools table (leverages existing schema)
ALTER TABLE tools ADD COLUMN required_intents TEXT;

-- Create intents table for better organization (follows existing pattern)
CREATE TABLE IF NOT EXISTS intents (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    category TEXT,
    keywords TEXT,  -- Comma-separated keywords for LLM matching
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance (follows existing indexing pattern)
CREATE INDEX IF NOT EXISTS idx_tools_required_intents ON tools(required_intents);
CREATE INDEX IF NOT EXISTS idx_intents_name ON intents(name);
CREATE INDEX IF NOT EXISTS idx_intents_category ON intents(category);

-- Insert initial intents for common operations
INSERT OR IGNORE INTO intents (name, description, category, keywords) VALUES
    ('codebase_analysis', 'Analyze code structure, patterns, and quality', 'analysis', 'analyze,code,codebase,review,structure,pattern,quality'),
    ('code_review', 'Review code for issues, bugs, and improvements', 'analysis', 'review,code,bug,issue,improve,quality'),
    ('debug', 'Debug code issues and find problems', 'analysis', 'debug,error,issue,problem,fix,trace'),
    ('optimization', 'Optimize code performance and efficiency', 'analysis', 'optimize,performance,speed,efficiency,improve'),
    ('system_performance', 'Monitor and analyze system performance', 'monitoring', 'performance,system,cpu,memory,disk,monitor'),
    ('monitoring', 'Monitor system resources and health', 'monitoring', 'monitor,watch,track,health,status,resource'),
    ('conversation_management', 'Manage conversation sessions and context', 'context', 'conversation,session,context,chat,message'),
    ('context_setup', 'Set up and initialize context', 'context', 'context,setup,initialize,create,start'),
    ('filesystem_scan', 'Scan and explore filesystem', 'filesystem', 'file,filesystem,scan,explore,directory,folder'),
    ('file_operations', 'Read, write, and manipulate files', 'filesystem', 'file,read,write,edit,content,text');

-- Map existing tools to intents (based on tool names and functionality)
-- System monitoring tools
UPDATE tools SET required_intents = 'system_performance,monitoring' WHERE name = 'get_cpu_info';
UPDATE tools SET required_intents = 'system_performance,monitoring' WHERE name = 'get_disk_info';
UPDATE tools SET required_intents = 'system_performance,monitoring' WHERE name = 'get_host_info';
UPDATE tools SET required_intents = 'system_performance,monitoring' WHERE name = 'get_memory_info';
UPDATE tools SET required_intents = 'system_performance,monitoring' WHERE name = 'get_network_info';
UPDATE tools SET required_intents = 'system_performance,monitoring,debug' WHERE name = 'get_process_info';

-- Codebase analysis tools
UPDATE tools SET required_intents = 'codebase_analysis,code_review,debug,optimization' WHERE name = 'analyze_codebase';
UPDATE tools SET required_intents = 'codebase_analysis,context_setup' WHERE name = 'auto_learn_if_needed';
UPDATE tools SET required_intents = 'codebase_analysis,context_setup' WHERE name = 'contribute_insights';
UPDATE tools SET required_intents = 'codebase_analysis,code_review' WHERE name = 'generate_documentation';
UPDATE tools SET required_intents = 'codebase_analysis' WHERE name = 'get_developer_profile';
UPDATE tools SET required_intents = 'filesystem_scan,codebase_analysis' WHERE name = 'get_file_content';
UPDATE tools SET required_intents = 'monitoring,codebase_analysis' WHERE name = 'get_intelligence_metrics';
UPDATE tools SET required_intents = 'monitoring,codebase_analysis' WHERE name = 'get_learning_status';
UPDATE tools SET required_intents = 'codebase_analysis,optimization' WHERE name = 'get_pattern_recommendations';
UPDATE tools SET required_intents = 'system_performance,monitoring' WHERE name = 'get_performance_status';
UPDATE tools SET required_intents = 'filesystem_scan,codebase_analysis' WHERE name = 'get_project_structure';
UPDATE tools SET required_intents = 'codebase_analysis,code_review' WHERE name = 'get_semantic_insights';
UPDATE tools SET required_intents = 'system_performance,monitoring' WHERE name = 'get_system_status';
UPDATE tools SET required_intents = 'codebase_analysis,context_setup' WHERE name = 'learn_codebase_intelligence';