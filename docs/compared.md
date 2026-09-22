# What wilanis is not

The [README](../README.md) says what wilanis is. This page says what it is not, against the things it is most
often taken for, since each of them also runs a graph or reads a JSON file and none of them makes the
judgement the compiler makes.

**Not a framework.** Express, Rails and NestJS call your code at the points they define, and what they call is
still code, with everything code can do. Here there is no code to call. The documents are the program, the
expression language cannot loop, call or reach a socket, and what the language cannot say goes behind a port
in a plugin, held to what the port declares. That is the boundary of a language, not an extension point.

**Not a workflow engine.** Step Functions, Airflow and Temporal run a graph you hand them, written as JSON,
as YAML or as code; what it touches is the runtime's business at the moment it touches it. Here a graph is
one document kind among a dozen, and the point is what the compiler does with all of them at once: that a
route answers a shape its graph can produce, that the port behind it is met by a binding, that every reason
the graphs and policies behind it can refuse with is given an answer, and that none is answered which they
cannot reach, one judgement over the whole tree, before anything starts. An invariant is what that buys
you: a rule an author states once, in one file, and the checker holds at every place it applies, including
the route written a year later by someone who never read it.

**Not a low-code tool.** n8n, Node-RED and Zapier are a canvas first and files second. Here the files are the
source. They are diffed, reviewed and merged like any others, and the viewer is read-only: it draws a tree
and grants it nothing. No editor owns the truth.

**Not a configuration language.** Dhall, CUE, Jsonnet and Pkl make configuration safe to write and generate.
Nothing is generated here. The documents are the program, and what the checker knows about them is a
service: layers, ports, policies, effects and the types that flow between them.

**Not JSON for its own sake.** The format is the least interesting decision. JSON because every editor,
schema, diff and model already reads it. What is worth having is the checker, and it would judge the same
tree written any other way.

**Not this code.** wilanis is a language, and what a language is, its specification says: here, the document
kinds and their schemas, the rules the checker judges by, each with its code, and the promises the runtime
keeps. What a tree starts is declared, a guard stands before any graph, a rule stated once holds everywhere.
This repository is the reference implementation of that specification, in TypeScript, which is why it is
called `wilanis-js`. An implementation in another language that makes the same judgement over the same tree is
wilanis. A fork that changes what a schema means or what a rule refuses is another language, and owes its
documents another `$schema`. Today the specification is the RFCs under [`rfcs/`](rfcs/README.md) and the
example with its sabotaged variants, which say for every rule what breaks it and what code it answers; a
document of its own comes once this definition has settled.
