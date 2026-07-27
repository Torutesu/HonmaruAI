Trial 1: Development Assignment Guide
Thank you for applying.
We aim to dominate the context layer globally and, from that starting point, create a wide variety of products. Our future development will not be limited to software. We are considering business expansion across a broad range of areas, including hardware and real-world businesses. Furthermore, we plan to develop numerous internal tools to support these endeavors.
As we move forward to create many new products and businesses, we want to meet exceptional engineers. Therefore, we have established this selection process.
First and foremost, we sincerely thank you for your interest in our company and for applying. Thank you.

About the Development Assignment
For this assignment, we would like you to develop an actual working product over a period of about 1 to 3 days.
In this assignment, we are not simply evaluating the volume of code or technical difficulty. We want to see if you can appropriately select and prioritize features within a limited timeframe, design the product structure, obsess over the details, and build it out as quickly as possible to a state where users can actually interact with it.
You do not need to perfectly implement all requirements.
We will also evaluate how you prioritize features, what parts you choose to simplify, and how you establish the essential experience of the product within the given time constraints.

Assignment Theme
TikTok for Work
Please develop a native iOS mobile application intended for use by multi-person teams or organizations.
This is not a personal AI assistant.
It is a product designed for multiple users belonging to a company or team to communicate, make decisions, delegate tasks, approve requests, and share information via AI.
The goal is not to create a mere alternative to Slack, but a new work platform optimized for an AI-native work style that goes far beyond "Slack 2.0."
Rather than assuming the current work style where humans interact directly through channels and DMs, all communication entry points will be unified into a "dialogue with your own AI."

Core Concept
As a general rule, humans will only interact with their own AI.
For example, a user conveys the following intentions to their AI:
I want to convey this to Person A.
I want to delegate this task to someone.
I want approval from the person in charge regarding this policy.
I want this issue shared with the appropriate assignee.
I want this change reflected to the development team.
The AI, having received the user's intention, determines the appropriate recipient within the organization and communicates with that recipient's AI in real-time.
The receiving AI does not merely pass on the raw message; it converts it into a "Decision Card" in a format that makes it easy for the recipient to make a decision, factoring in their role, responsibilities, priorities, and current situation.
There is no need for humans to directly manage channels, DMs, mentions, or inboxes with one another.
All communication is translated, organized, and prioritized by AI, and only the necessary information is delivered to the necessary people.
Through this structure, we aim to resolve the following issues prevalent in Slack and similar tools:
The problem of ever-increasing channels.
The problem of missing important information due to notification overload.
The problem of not knowing who is checking which channel.
The problem of information being scattered across DMs and channels.
The problem of not knowing who should make a decision.
The problem of tasks and decisions getting buried in conversations.
The problem of explaining the same content multiple times to different people.

Assumed Product Structure
1. Frontend
Users interact with their dedicated AI agent on a TikTok-like vertical scrolling feed.
AI-generated Decision Cards are displayed one by one on the home screen.
Users process the cards by swiping, tapping, or inputting text.
For example, the following actions are expected:
Approve
Reject
Request revision
Delegate to another person
Check details
Change priority
Give additional instructions to the AI

2. Inter-AI Communication Layer
A dedicated AI agent is linked to each user in the organization.
When a user gives an instruction to their AI, that AI communicates with other users' AIs as necessary.
Actions such as "tell someone," "delegate a task," and "request approval" are all processed between AIs.
The concept of humans directly manipulating another person's inbox or channels does not exist.
Please build the inter-AI communication using real-time communication like WebSockets, or a simplified mechanism that can be reproduced within the assignment timeframe.

3. Synchronization to GitHub
The following information, finalized through AI interactions, is automatically synced to GitHub:
Decisions
Tasks
Changes in assignees
Approval results
Development requests
Updates to Issues or Pull Requests
As reflection destinations, we assume the following:
GitHub Issues
Pull Requests
GitHub Discussions
GitHub Projects
General users do not need to be aware of what is recorded where on GitHub.
However, we assume a state where engineers and technical staff can check the same information directly from GitHub.

4. Modeling of Organization, Roles, and Responsibilities
Please include a simplified organizational graph within the app.
The organizational graph should include information such as:
Nodes: Individuals, Teams, AI Agents, Projects
Edges: Manager-subordinate relationships, Affiliated teams, Assigned projects, Permissions, Scope of responsibilities, Approval authority
Based on this organizational information, the AI determines who the information should be delivered to and who should make the decision.
Instead of delivering all information to everyone, display only the "cards that the person should decide on right now" to each user.

Mandatory Requirements
Platform: Must be a native iOS mobile application. Must use Swift or SwiftUI. Must be submitted in an operable, working state.
Multi-User: Can create or reproduce an organization with multiple users. A distinct AI agent is linked to each user. Different Decision Cards are displayed for each user. One user's instructions are reflected on another user's screen.
GitHub Integration: Can log in with a GitHub account. Can fetch GitHub repository information. Can sync information to either Issues, Pull Requests, Discussions, or Projects. (If OAuth integration is difficult within the assignment timeframe, you may use a GitHub Personal Access Token or a testing connection method).
AI Interaction Feed: Decision Cards are displayed in a vertical scrolling format. Decisions can be made on a per-card basis. Instructions can be inputted to the AI via text. AI interprets the text input and executes the appropriate action.
Inter-AI Communication: User A's instructions are sent to User B's AI. The instruction is displayed to User B as a Decision Card, not as a raw message. Results such as approval, rejection, or delegation are reflected back to the sender (User A).

Regarding the Scope of Implementation
You are not required to implement everything above at production quality within 3 days.
In this assignment, we prioritize ensuring that the following core flow actually works:
User A gives an instruction to their AI.
The AI determines the intent of the instruction and the appropriate assignee.
The content is sent to User B's AI.
A Decision Card is displayed to User B.
User B makes a decision (approve, reject, request revision, etc.).
The decision result is reflected back to User A.
The finalized content is synced to GitHub.
It is acceptable to use mock data or simplified implementations for some of the AI processing, the organizational graph, and real-time communication.
However, please ensure that it is not just a static mock consisting only of screens, but rather a state where the core operations are actually connected and functioning.

Development Period
Please submit your work within a maximum of 3 days from the time this assignment is shared with you.
If you complete it in about 1 day, you are more than welcome to submit it before the 3-day period ends.

Deliverables
Please submit the following two items:
GitHub Repository: Please share a GitHub repository where we can review your implemented code. In the README, please include the following to the extent possible: Product overview, Technologies used, Setup instructions, Key features, System architecture, Implemented scope, Simplified or mocked scope, Ingenious points / Efforts made, Areas for future improvement.
Actual Working Product: Please submit the app in a state where we can actually operate and verify it. We assume one of the following formats: Distribution via TestFlight, Installable build, A release file that works on an actual device or simulator, Any other format that allows us to actually operate the app.
Submitting code that only runs in your local environment is insufficient. We strictly require that the product is built to a state where users can actually interact with it.

About Development Means
The means of development are entirely up to you.
You are completely free to utilize any of the following:
AI coding tools
OSS and external libraries
Reusing code you have written in the past
Existing services and APIs
Templates and boilerplates
Backend as a Service (BaaS)
Mock data and test accounts
We do not expect you to implement everything from scratch.
We highly value the ability to appropriately combine existing technologies and tools to complete a product efficiently in a short period.

About Costs
There is no need to use expensive cloud services or paid APIs.
You also do not need to incur significant costs to improve the accuracy of models or features.
Please utilize free tiers or low-cost services to achieve a state where the product's structure and core user experience can be evaluated.

Evaluation Criteria
We will primarily look at the following points:
Were you able to appropriately select and prioritize features within the limited timeframe?
Is it designed as a product intended for use by multiple people?
Have you successfully expressed the new AI-native work style as a user experience?
Have you avoided making it just a standard chat app or a Slack clone?
Is it fully completed as a product?
Is it designed so that users can navigate and operate it without confusion?
Is attention paid to details such as UI, animations, and responsiveness?
Are the code and system structures appropriately designed?
Did you develop efficiently by utilizing AI, OSS, etc.?
Are your own ideas and decisions reflected in the product?
Is it polished to a state where it could be provided to actual users?
We are not looking for an exhaustive feature list or excessively difficult technical implementations.
We are looking at your ability to identify the necessary features, obsess over the essential product experience and details, and push a single product to completion in a short amount of time.

Consultation Regarding the Assignment
If this assignment significantly differs from your technical domain, if implementation within 3 days feels unrealistic, or if you feel it is excessively challenging, please do not hesitate to contact us.
In such cases, we are happy to consider alternatives, including providing a different assignment.

Confirmation Items Regarding the Selection Assignment
Before starting and submitting the assignment, please review the following points carefully.
No Guarantee of Hiring: The execution, submission, or evaluation of this assignment does not guarantee hiring, contracting, employment, or any other agreement. Even after submission, depending on the selection results, it may not lead to hiring or a contract.
Remuneration and Expenses: This assignment is to be completed free of charge as part of the selection process. No remuneration, commission fee, reward, or other monetary compensation will be paid by us for the development, submission, revision, or any associated work. Additionally, any costs necessary for development are generally the responsibility of the applicant, including: Communication costs, Device costs, Cloud service usage fees, API usage fees, Software usage fees, Other development expenses. There is no need to use expensive paid services; please use free tiers or low-cost services whenever possible.
Rights to Deliverables: The rights to the deliverables newly created and submitted to us for this assignment will transfer to us at the time of submission. The applicant agrees not to exercise moral rights regarding the deliverables. However, regarding code, OSS, third-party libraries, templates, materials, etc., owned by the applicant prior to the assignment, the licenses and terms of use set by the respective rights holders shall apply.
Third-Party Rights: Please ensure your submission does not include anything that infringes upon third-party copyrights, patents, trademarks, trade secrets, personal information, or other rights. Furthermore, do not use unreleased code, confidential information, customer information, internal information, etc., belonging to third parties.
Confidentiality: Please do not disclose, share, or repurpose any non-public information, ideas, specifications, materials, or other information shared by us through this assignment to third parties without our explicit permission.
Consent by Submission: Please only proceed with the assignment and submit your deliverables if you have no issues with the contents above. At the moment you submit deliverables, GitHub repositories, public URLs, build files, or any other materials to us, you are deemed to have reviewed and fully agreed to all of these confirmation items.
Please review the above details, and if there are no issues, we look forward to your submission. Thank you very much.
