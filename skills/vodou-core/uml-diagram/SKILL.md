---
name: uml-diagram
description: Generate UML diagrams and visualizations using PlantUML with real-time rendering for system design and documentation
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "generate uml"
  - "create diagram"
  - "uml diagram"
  - "plantuml"
  - "class diagram"
  - "sequence diagram"
  - "activity diagram"
  - "draw diagram"
stopping_points: required
actions: actions.json
imported_from:
  source: hand-written
---

# Vodou UML Diagram Generator

## Overview

Transform your system design ideas into professional UML diagrams instantly. This skill leverages the uml-mcp server to generate class diagrams, sequence diagrams, activity diagrams, and more using PlantUML syntax with real-time rendering capabilities.

## Prerequisites

- uml-mcp server must be connected and healthy
- Internet connection for PlantUML rendering (or local PlantUML server)
- Basic understanding of UML diagram concepts

## Core Workflow

### 1. Diagram Planning and Analysis

**⏸️ STOPPING POINT - Diagram Requirements**

Before generating diagrams, let's identify your needs:

**"I'll help you create professional UML diagrams. What type of visualization do you need?"**

1. **Class Diagram** - Show classes, attributes, methods, and relationships
2. **Sequence Diagram** - Display interactions between objects over time
3. **Activity Diagram** - Illustrate workflows and business processes
4. **Use Case Diagram** - Document actors and use cases
5. **State Diagram** - Show state transitions and behavior
6. **Component Diagram** - Visualize system components and dependencies
7. **Other UML Types** - Deployment, object, or custom diagrams

**Which diagram type best fits your needs?**

<!-- AGENT_ACTIONS: {"stopping_points": [
  {
    "id": 1,
    "title": "Diagram Requirements",
    "options": {
      "1": {"label":"Class Diagram from description","vars":{"DIAGRAM_TYPE":"class"},"steps":[
        {"server":"uml-mcp","tool":"generate_uml","args":{"type":"{{DIAGRAM_TYPE}}","source":"{{TOPIC}}"}}
      ]},
      "2": {"label":"Sequence Diagram","vars":{"DIAGRAM_TYPE":"sequence"},"steps":[
        {"server":"uml-mcp","tool":"generate_uml","args":{"type":"{{DIAGRAM_TYPE}}","source":"{{TOPIC}}"}}
      ]},
      "3": {"label":"Activity Diagram","vars":{"DIAGRAM_TYPE":"activity"},"steps":[
        {"server":"uml-mcp","tool":"generate_uml","args":{"type":"{{DIAGRAM_TYPE}}","source":"{{TOPIC}}"}}
      ]}
    }
  }
]} -->

### 2. Content Analysis and Code Generation

Once you've selected a diagram type, I'll help generate the appropriate PlantUML code:

```bash
# Class structure: summarize entities/relationships from your repo (search/read in editor), then pass that text into generate_uml or describe it in {{TOPIC}}
```

**⏸️ STOPPING POINT - PlantUML Code Review**

Based on your requirements, I'll generate PlantUML syntax. Here are the options:

**A)** Use existing code analysis to auto-generate diagram structure
**B)** Create diagram from scratch using your specifications
**C)** Start with a template and customize it together
**D)** Analyze existing UML files and improve them

**Which approach works best for your project?**

### 3. Diagram Generation and Rendering

Generate the UML diagram with real-time rendering:

```bash
# Generate class diagram
./vodou-core call uml-mcp generate_uml '{
  "diagram_type": "class",
  "code": "@startuml\nclass User {\n  -id: int\n  -name: string\n  +login(): boolean\n  +logout(): void\n}\n\nclass Order {\n  -id: int\n  -items: List<Item>\n  +addItem(item: Item): void\n  +calculateTotal(): double\n}\n\nUser \"1\" -- \"many\" Order: places\n@enduml"
}'

# Generate sequence diagram for user interactions
./vodou-core call uml-mcp generate_uml '{
  "diagram_type": "sequence",
  "code": "@startuml\nactor User\nparticipant \"Web App\" as WA\nparticipant \"API\" as API\nparticipant \"Database\" as DB\n\nUser -> WA: Login Request\nWA -> API: POST /auth/login\nAPI -> DB: Validate Credentials\nDB --> API: User Data\nAPI --> WA: JWT Token\nWA --> User: Login Success\n@enduml"
}'

# Generate activity diagram for workflows
./vodou-core call uml-mcp generate_uml '{
  "diagram_type": "activity",
  "code": "@startuml\nstart\n:User Login;\nif (Valid Credentials?) then (yes)\n  :Generate Token;\n  :Redirect to Dashboard;\n  stop\nelse (no)\n  :Show Error Message;\n  :Return to Login;\n  stop\nendif\n@enduml"
}'
```

### 4. Advanced Diagram Patterns

#### System Architecture Visualization
```bash
# Component diagram showing system architecture
./vodou-core call uml-mcp generate_uml '{
  "diagram_type": "component",
  "code": "@startuml\npackage \"Frontend\" {\n  [React App]\n  [Redux Store]\n}\n\npackage \"Backend\" {\n  [API Gateway]\n  [Auth Service]\n  [User Service]\n  [Payment Service]\n}\n\npackage \"Database\" {\n  [User DB]\n  [Order DB]\n  [Payment DB]\n}\n\n[React App] --> [API Gateway]\n[API Gateway] --> [Auth Service]\n[API Gateway] --> [User Service]\n[API Gateway] --> [Payment Service]\n[User Service] --> [User DB]\n[Payment Service] --> [Payment DB]\n@enduml"
}'
```

#### Database Entity Relationships
```bash
# Object diagram showing database relationships
./vodou-core call uml-mcp generate_uml '{
  "diagram_type": "object",
  "code": "@startuml\nobject User {\n  id = 1\n  name = \"John Doe\"\n  email = \"john@example.com\"\n}\n\nobject Order {\n  id = 101\n  date = \"2024-01-05\"\n  status = \"completed\"\n}\n\nobject Product {\n  id = 501\n  name = \"Laptop\"\n  price = 999.99\n}\n\nUser ||--o{ Order\nOrder ||--o{ Product\n@enduml"
}'
```

#### State Machine Modeling
```bash
# State diagram for user session management
./vodou-core call uml-mcp generate_uml '{
  "diagram_type": "state",
  "code": "@startuml\n[*] --> Logged_Out\nLogged_Out --> Authenticating : login_attempt\nAuthenticating --> Logged_In : success\nAuthenticating --> Logged_Out : failure\nLogged_In --> Active : user_activity\nLogged_In --> Idle : timeout\nIdle --> Active : user_activity\nIdle --> Logged_Out : session_expire\nActive --> Logged_Out : logout\n@enduml"
}'
```

## Advanced Usage

### Multi-Diagram Documentation Workflow

**⏸️ STOPPING POINT - Documentation Scope**

For comprehensive system documentation, I can generate multiple related diagrams:

**"I can create a complete diagram suite for your system. What's your documentation goal?"**

1. **System Overview** - High-level architecture with component diagrams
2. **User Interactions** - Use case and sequence diagrams  
3. **Data Flow** - Activity and state diagrams
4. **Code Structure** - Class and object diagrams
5. **Custom Focus** - Specific subsystem or feature area

**Which documentation approach would be most valuable?**

#### Complete System Documentation Example
```bash
# Generate comprehensive system documentation
./vodou-core call uml-mcp generate_uml '{
  "diagram_type": "usecase",
  "code": "@startuml\nactor User\nactor Admin\n\nrectangle \"E-commerce System\" {\n  User --> (Browse Products)\n  User --> (Add to Cart)\n  User --> (Checkout)\n  User --> (Track Order)\n  \n  Admin --> (Manage Products)\n  Admin --> (View Orders)\n  Admin --> (Generate Reports)\n}\n@enduml"
}'
```

### Integration with Code Analysis

Combine UML generation with code analysis for living documentation:

```bash
# Infer structure from src/ (layout, rg) and any **Vodou memory** notes on architecture; feed uml-mcp generate_uml with PlantUML or a rich {{TOPIC}}
```

### Collaborative Diagram Review

**⏸️ STOPPING POINT - Review and Refinement**

After generating initial diagrams:

**"Your diagram has been generated! Here's what I can help you with next:"**

1. **Refine the diagram** - Adjust layout, add details, or modify relationships
2. **Generate additional views** - Create related diagrams from different perspectives  
3. **Export variations** - Create different formats or simplified versions
4. **Integration planning** - Show how this fits with existing documentation

**What would be most helpful for your project?**

## Best Practices

### 1. **Start Simple, Add Complexity**
- Begin with core entities and relationships
- Add details incrementally
- Use PlantUML's grouping features for organization

### 2. **Follow UML Conventions**
- Use proper UML notation for relationships
- Include appropriate visibility modifiers (+, -, #, ~)
- Name classes and methods clearly

### 3. **Optimize for Readability**
- Group related elements logically
- Use consistent naming conventions
- Add notes and comments for clarity

### 4. **Version Control Your Diagrams**
- Save PlantUML code alongside your project
- Track changes to system design over time
- Use descriptive diagram titles and dates

## Examples

### Example 1: E-commerce Class Diagram
```bash
# Generate comprehensive e-commerce system class diagram
./vodou-core call uml-mcp generate_uml '{
  "diagram_type": "class",
  "code": "@startuml\ntitle E-commerce System - Core Classes\n\nclass User {\n  -id: Long\n  -username: String\n  -email: String\n  -password: String\n  +login(credentials): boolean\n  +logout(): void\n  +updateProfile(data): void\n}\n\nclass Product {\n  -id: Long\n  -name: String\n  -price: BigDecimal\n  -inventory: Integer\n  +updatePrice(price): void\n  +checkAvailability(): boolean\n}\n\nclass Order {\n  -id: Long\n  -date: LocalDateTime\n  -status: OrderStatus\n  -items: List<OrderItem>\n  +addItem(product, quantity): void\n  +calculateTotal(): BigDecimal\n  +process(): void\n}\n\nclass OrderItem {\n  -quantity: Integer\n  -unitPrice: BigDecimal\n  +getSubtotal(): BigDecimal\n}\n\nenum OrderStatus {\n  PENDING\n  PROCESSING\n  SHIPPED\n  DELIVERED\n  CANCELLED\n}\n\nUser \"1\" -- \"many\" Order : places\nOrder \"1\" -- \"many\" OrderItem : contains\nOrderItem \"many\" -- \"1\" Product : references\nOrder -- OrderStatus\n@enduml"
}'
```

### Example 2: Microservices Sequence Diagram
```bash
# Generate microservices interaction sequence diagram
./vodou-core call uml-mcp generate_uml '{
  "diagram_type": "sequence",
  "code": "@startuml\ntitle Order Processing - Microservices Flow\n\nactor Customer\nparticipant \"Web UI\" as UI\nparticipant \"API Gateway\" as Gateway\nparticipant \"Order Service\" as Order\nparticipant \"Payment Service\" as Payment\nparticipant \"Inventory Service\" as Inventory\nparticipant \"Notification Service\" as Notification\n\nCustomer -> UI: Place Order\nUI -> Gateway: POST /orders\nGateway -> Order: Create Order\n\nOrder -> Inventory: Check Stock\nInventory --> Order: Stock Available\n\nOrder -> Payment: Process Payment\nPayment --> Order: Payment Successful\n\nOrder -> Inventory: Reserve Items\nInventory --> Order: Items Reserved\n\nOrder -> Notification: Send Confirmation\nNotification --> Customer: Order Confirmation Email\n\nOrder --> Gateway: Order Created\nGateway --> UI: Success Response\nUI --> Customer: Order Confirmation\n@enduml"
}'
```

### Example 3: User Journey Activity Diagram
```bash
# Generate user registration and onboarding activity diagram
./vodou-core call uml-mcp generate_uml '{
  "diagram_type": "activity",
  "code": "@startuml\ntitle User Onboarding Process\n\nstart\n:User visits registration page;\n:Fill registration form;\n\nif (Valid data?) then (yes)\n  :Create account;\n  :Send verification email;\n  :Wait for email verification;\n  \n  if (Email verified?) then (yes)\n    :Activate account;\n    :Show welcome tutorial;\n    \n    if (Complete tutorial?) then (yes)\n      :Redirect to dashboard;\n      :Log onboarding complete;\n      stop\n    else (skip)\n      :Redirect to dashboard;\n      :Mark tutorial as skipped;\n      stop\n    endif\n  else (timeout)\n    :Send reminder email;\n    :Account remains inactive;\n    stop\n  endif\nelse (no)\n  :Show validation errors;\n  :Return to form;\n  stop\nendif\n@enduml"
}'
```

## Troubleshooting

### Common Issues

**Problem**: PlantUML syntax errors in generated diagrams
**Solution**: Validate PlantUML code at http://www.plantuml.com/plantuml before generating

**Problem**: Complex diagrams are hard to read
**Solution**: Break large diagrams into smaller, focused views using PlantUML packages

**Problem**: Diagram doesn't render or shows error
**Solution**: 
```bash
# Check uml-mcp server health
./vodou-core call uml-mcp generate_uml '{"diagram_type": "class", "code": "@startuml\nclass Test\n@enduml"}'

# Verify PlantUML server connectivity
# Default server: http://www.plantuml.com/plantuml
```

**Problem**: Need offline diagram generation
**Solution**: Set up local PlantUML server:
```bash
# Run local PlantUML server with Docker
docker run -d -p 8080:8080 plantuml/plantuml-server

# Configure uml-mcp to use local server
export PLANTUML_SERVER="http://localhost:8080"
```

## 🔗 URL Display Best Practices

**CRITICAL**: When presenting UML diagram results, always format URLs properly to prevent truncation!

### ✅ **CORRECT URL Presentation:**
```markdown
🔗 **View Your Diagram:** [Click here to view your UML Class Diagram](full-plantuml-url)

🎨 **Your UML Diagram is Ready!**
[**→ View Class Diagram**](url-here)
```

### ❌ **INCORRECT - Causes Truncation:**
```markdown
Your diagram URL: http://www.plantuml.com/plantuml/svg/very-long-encoded-string-that-gets-cut-off-in-display...
```

### 📋 **AI Agent URL Handling Instructions:**

When presenting diagram results to users:

1. **Use Markdown Links**: Always format as `[descriptive text](URL)` - NEVER show raw URLs
2. **Descriptive Text**: Use clear action words like "View your Class Diagram" 
3. **Visual Emphasis**: Add emojis (🔗, 🎨, 📊) and **bold** formatting
4. **Accessibility**: Ensure links work in all environments
5. **Context**: Include diagram type in link text
6. **⚠️ CRITICAL**: Keep link text SHORT to prevent line wrapping that breaks clickability
7. **⚠️ CRITICAL**: Never show raw URLs as they get truncated and become unclickable

### 📝 **Example Proper Response Format:**
```markdown
## 🎨 **UML Diagram Generated Successfully!**

🔗 **View Your Diagram:** [**→ View Class Diagram**](plantuml-url)

**Diagram Type**: Class Diagram  
**Format**: SVG (scalable vector graphics)  
**Status**: ✅ Ready for viewing and sharing
```

### ⚠️ **CRITICAL LINK FORMAT RULES:**

**✅ GOOD - Short Link Text (Prevents Line Wrapping):**
- `[**→ View Diagram**](url)`
- `[**Class Diagram**](url)` 
- `[**→ Open**](url)`
- `[**View UML**](url)`

**❌ BAD - Long Link Text (Causes Line Wrapping):**
- `[Click here to view your comprehensive UML Class Diagram with all relationships](url)` ❌ TOO LONG
- `[View your detailed system architecture component diagram](url)` ❌ TOO LONG

**🎯 OPTIMAL FORMAT:**
```markdown
🔗 [**→ View Diagram**](url)
```

### 🚨 **TERMINAL DISPLAY ISSUE - PlantUML URLs Are Inherently Long**

**PROBLEM**: PlantUML URLs are 80-200+ characters and WILL wrap in most terminal windows, causing the markdown link to break and only the first line to be clickable.

**SOLUTIONS**:

#### **Option 1: Block Format (Recommended)**
```markdown
🔗 **UML Diagram Ready!**

[**→ CLICK HERE TO VIEW DIAGRAM**](url)

**Type**: Class Diagram
```

#### **Option 2: Separated Display**
```markdown
## 🎨 **Your UML Diagram is Ready!**

**Diagram Type:** Class Diagram  
**Status:** ✅ Generated successfully

**🔗 View Link:**  
[**OPEN DIAGRAM**](url)
```

#### **Option 3: Copy-Paste Instructions (RECOMMENDED)**
```markdown
🔗 **Diagram Generated!**

**To view your diagram, copy this URL to your browser:**

http://www.plantuml.com/plantuml/svg/encoded-string-here

**Type:** Class Diagram | **Format:** SVG
```

#### **Option 4: Code Block Format (Alternative)**
```markdown
## 🎨 **UML Diagram Ready!**

Copy and paste this URL into your browser to view:

```
http://www.plantuml.com/plantuml/svg/encoded-string-here
```

**Diagram Details:** Class diagram with User/Order relationship
```

**⚠️ IMPORTANT**: PlantUML URLs are 80-200+ characters and will wrap in terminals. Copy-paste approach (Option 3 & 4) eliminates clickability issues entirely.

**✅ RECOMMENDED**: Use copy-paste format to avoid all terminal line-wrapping and clickability problems!

## Integration with Other Skills

### With Code Analysis
```bash
# Summarize structure from the repo, then generate class diagram from that summary
./do "generate uml class diagram for [subsystem]"
```

### With Documentation
```bash
# Create diagrams as part of documentation workflow
./do "generate system documentation with uml diagrams"
```

### With Architecture Planning
```bash
# Use for system design and architecture discussions
./do "design microservices architecture with component diagrams"
```

## Quick Reference

```bash
# Generate class diagram
./vodou-core call uml-mcp generate_uml '{"diagram_type": "class", "code": "@startuml\nclass Example\n@enduml"}'

# Generate sequence diagram  
./vodou-core call uml-mcp generate_uml '{"diagram_type": "sequence", "code": "@startuml\nA -> B: message\n@enduml"}'

# Generate activity diagram
./vodou-core call uml-mcp generate_uml '{"diagram_type": "activity", "code": "@startuml\nstart\n:action;\nstop\n@enduml"}'

# Check server health
./vodou-core call uml-mcp generate_uml '{"diagram_type": "class", "code": "@startuml\nclass Health\n@enduml"}'
```

## Performance Tips

1. **Keep diagrams focused** - One diagram per concept or system area
2. **Use packages** - Organize related elements with PlantUML packages
3. **Leverage templates** - Create reusable PlantUML code patterns
4. **Validate syntax** - Check PlantUML syntax before generation to avoid errors

Transform your system designs into clear, professional diagrams that communicate effectively with stakeholders and team members!