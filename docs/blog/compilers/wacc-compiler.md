---
icon: lucide/code-2
---

# Compilers

This write-up is about a compiler my group and I have written during the [WACC](https://blogs.imperial.ac.uk/computing/2024/02/28/second-year-projects-wacc-and-pintos/) group project during Imperial 2nd year of Computing.

I was quite fascinated about how interesting (and challenging) it is to write a compiler even for simple languages (like WACC). While my initial thoughts about compilers were biased (*parsers*), using a functional language like [Scala 3](https://scala-lang.org/) helped me get over this and enjoy the process.

## Structure of Compilers

Typically, a compiler consists of a:
1) Frontend
2) Backend

Although, it is possible to have "mid-end"s between the two stages, for example, if the compiler supports staged metaprogramming.

While the frontend is concerned with the syntax and semantics of the language and validating it, the backend consists of code generation and emitting of assembly.

However, it is possible to compile a language into another source language instead of direct generation of assembly, in which case these are called *transpilers*. Originally, Haskell used to emit C code instead of assembly, making it a transpiler.

## Frontend

The frontend typically has this pipeline:

1) Parser
2) Renamer
3) Typechecker

Obviously, this pipeline can be expanded / shrinked depending on language grammar / complexity.

For example, Scala 3 has 80+ passes! They are:

??? info "Scala Phases"
    ```
    phase name  description
    ----------  -----------
        parser  scan and parse sources
         typer  type the trees
    checkUnusedPostTyper  check for unused elements
    checkShadowing  check for elements shadowing other elements in scope
    inlinedPositions  check inlined positions
      sbt-deps  sends information on classes' dependencies to sbt
    extractSemanticDBExtractSemanticInfo
                extract info into .semanticdb files
     posttyper  additional checks and cleanups after type checking
    unrollDefs  generates forwarders for methods annotated with @unroll
    prepjsinterop  additional checks and transformations for Scala.js
    SetRootTree  set the rootTreeOrProvider on class symbols
       pickler  generates TASTy info
       sbt-api  sends a representation of the API of classes to sbt
      inlining  inline and execute macros
    postInlining  add mirror support for inlined code
       staging  check staging levels and heal staged types
      splicing  splicing
    pickleQuotes  turn quoted trees into explicit run-time data
                structures
    checkUnusedPostInlining  check for unused elements
    instrumentCoverage  instrument code for coverage checking
    crossVersionChecks  check issues related to deprecated and experimental
    firstTransform  some transformations to put trees into a canonical form
    checkReentrant  check no data races involving global vars
    elimPackagePrefixes  eliminate references to package prefixes in Select
                nodes
    cookComments  cook the comments: expand variables, doc, etc.
    checkLoopingImplicits  check that implicit defs do not call themselves in an
                infinite loop
    betaReduce  reduce closure applications
    inlineVals  check right hand-sides of an `inline val`s
    expandSAMs  expand SAM closures to anonymous classes
    elimRepeated  rewrite vararg parameters and arguments
     refchecks  checks related to abstract members and overriding
    dropForMap  Drop unused trailing map calls in for comprehensions
    extractSemanticDBAppendDiagnostics
                extract info into .semanticdb files
    initChecker  check initialization of objects
    protectedAccessors  add accessors for protected members
    extmethods  expand methods of value classes with extension methods
    uncacheGivenAliases  avoid caching RHS of simple parameterless given aliases
    checkStatic  check restrictions that apply to @static members
    elimByName  map by-name parameters to functions
    hoistSuperArgs  hoist complex arguments of supercalls to enclosing
                scope
    forwardDepChecks  ensure no forward references to local vals
    specializeApplyMethods  adds specialized methods to FunctionN
    tryCatchPatterns  compile cases in try/catch
    patternMatcher  compile pattern matches
    preRecheck  preRecheck
       recheck  recheck
       setupCC  prepare compilation unit for capture checking
            cc  capture checking
    elimOpaque  turn opaque into normal aliases
    explicitJSClasses  make all JS classes explicit
    explicitOuter  add accessors to outer classes from nested ones
    explicitSelf  make references to non-trivial self types explicit as
                casts
    interpolators  optimize s, f, and raw string interpolators
    dropBreaks  replace local Break throws by labeled returns
    pruneErasedDefs  drop erased definitions and simplify erased expressions
    uninitialized  eliminates `compiletime.uninitialized`
    inlinePatterns  remove placeholders of inlined patterns
    vcInlineMethods  inlines calls to value class methods
    seqLiterals  express vararg arguments as arrays
    intercepted  rewrite universal `!=`, `##` methods
       getters  replace non-private vals and vars with getter defs
    specializeFunctions  specialize Function{0,1,2} by replacing super with
                specialized super
    specializeTuples  replaces tuple construction and selection trees
    collectNullableFields  collect fields that can be nulled out after use in lazy
                initialization
    elimOuterSelect  expand outer selections
    resolveSuper  implement super accessors
    functionXXLForwarders  add forwarders for FunctionXXL apply methods
    paramForwarding  add forwarders for aliases of superclass parameters
    genericTuples  optimize generic operations on tuples
    letOverApply  lift blocks from receivers of applications
    arrayConstructors  intercept creation of (non-generic) arrays and
                intrinsify
       erasure  rewrite types to JVM model
    elimErasedValueType  expand erased value types to their underlying
                implementation types
     pureStats  remove pure statements in blocks
    vcElideAllocations  peep-hole optimization to eliminate unnecessary value
                class allocations
     etaReduce  reduce eta expansions of pure paths
    arrayApply  optimize `scala.Array.apply`
    addLocalJSFakeNews  adds fake new invocations to local JS classes in calls
                to `createLocalJSClass`
    elimPolyFunction  rewrite PolyFunction subclasses to FunctionN subclasses
       tailrec  rewrite tail recursion to loops
    completeJavaEnums  fill in constructors for Java enums
         mixin  expand trait fields and trait initializers
      lazyVals  expand lazy vals
       memoize  add private fields to getters and setters
    nonLocalReturns  expand non-local returns
    capturedVars  represent vars captured by closures as heap objects
    constructors  collect initialization code in primary constructors
    instrumentation  count calls and allocations under -Yinstrument
    lambdaLift  lifts out nested functions to class scope
    elimStaticThis  replace This references to static objects by global
                identifiers
    countOuterAccesses  identify outer accessors that can be dropped
    dropOuterAccessors  drop unused outer accessors
    dropParentRefinements  drop parent refinements from a template
    checkNoSuperThis  check that supercalls don't contain references to This
       flatten  lift all inner classes to package scope
    transformWildcards  replace wildcards with default values
    moveStatic  move static methods from companion to the class itself
    expandPrivate  widen private definitions accessed from nested classes
    restoreScopes  repair rendered invalid scopes
    selectStatic  get rid of selects that would be compiled into
                GetStatic
    junitBootstrappers  generate JUnit-specific bootstrapper classes for
                Scala.js
    Collect entry points  collect all entry points and save them in the context
    collectSuperCalls  find classes that are called with super
    repeatableAnnotations  aggregate repeatable annotations
      genSJSIR  generate .sjsir files for Scala.js
      genBCode  generate JVM bytecode
    ```

The last stage, `genBCode` generates the JVM bytecode (as Scala is a JVM language), therefore it can be considered as its backend.

Scala 3 is a quite complicated language with an extensive syntax. Therefore, it makes sense for it to have this large of a frontend, which is experienced by its somewhat longer compilation times.

However, WACC is a simple language based on the While language family, therefore the frontend can be consisting of only these 3 stages.


!!! note

    A lexing stage (in which source language is converted to tokens) might come before parser, but since we used [Parsley](https://j-mie6.github.io/parsley/), it handled lexing and parsing altogether, which eliminated the need of a separate lexing stage.

### Parser

Parser is the stage where source language gets converted to syntactic information. Note that the context is syntactic, which means it is just concerned with converting the language into a tree structure (called AST) by obeying language grammar rules.

The grammar rules are often represented in the BNF form, such as:

```
<digit> ::= 0 | 1 | 2 | 3 | 4 | 5 | 6 |7 | 8 | 9
<integer> ::= <digit> | <digit><integer>
<floating point> ::= <integer>.<integer>
```

Or more generally:

```
<rule> ::= <token1> | <token2> | ...
```

These set of BNF grammar rules are able to fully describe the source language, and it is left to parser to parse the source language and generate an AST structure.

We used a parser-combinator library called Parsley to make our lives easier. Combined with the ease of use of Scala, representing the language using combinators were effective and simple. 

Our example parsers include:

```scala
/* Statements */
private lazy val stmt: Parsley[Stmt[UN]] =
  (extraSemicolonErr | skip | decl | update | scope | read | free | ret | exit | print | println | ifElse | whileDo)
    .label("statement")
    .explain("expected a valid statement (e.g. assignment, control flow, or I/O)")


private lazy val skip: Parsley[Stmt.Skip[UN]]       = Skip from "skip"
private lazy val decl: Parsley[Stmt.Decl]           = Decl(typ, unnamed, "=" ~> rvalue)
private lazy val update: Parsley[Stmt.Update[UN]]   = Update(lvalue <~ "=", rvalue, semTypeUnknown)
private lazy val scope: Parsley[Stmt.Scope[UN]]     = Scope(block(stmts), noVars)
private lazy val read: Parsley[Stmt.Read[UN]]       = Read("read" ~> lvalue)
private lazy val free: Parsley[Stmt.Free[UN]]       = Free("free" ~> expr)
private lazy val ret: Parsley[Stmt.Return[UN]]      = Return("return" ~> expr)
private lazy val exit: Parsley[Stmt.Exit[UN]]       = Exit("exit" ~> expr)
private lazy val print: Parsley[Stmt.Print[UN]]     = Print("print" ~> expr)
private lazy val println: Parsley[Stmt.Println[UN]] = Println("println" ~> expr)
private lazy val ifElse: Parsley[Stmt.IfElse[UN]]   = IfElseScoped("if" ~> expr, (missingThenErr | "then") ~> Scope(stmts, noVars), "else"
  .explain("if statements must have both a then and an else branch") ~> Scope(stmts, noVars) <~ "fi")
```

As can be seen, it is relatively easy to parse source language (strings) into AST Nodes.

### AST

An abstract syntax tree (AST) is a tree data structure that is used to store language information. 

It mainly consists of Expressions (`Expr`), statements (`Stmt`), and other nodes depending on the language.

In Scala 3, we modeled this using enums and case classes, which makes pattern matching incredibly powerful later on. For instance, a simple expression AST might look something like this:

```scala
object Expr {
  sealed trait Literal[T <: Id] extends Expr[T]
  // ... (literals)
  sealed trait BinOp[T <: Id] extends Expr[T] { val x: Expr[T] ; val y: Expr[T] }
  // ... (binary ops)
  sealed trait UnOp[T <: Id] extends Expr[T] { val x: Expr[T] }
  // ... (unary ops)
  // more nodes
```

Once the parser gives us this tree, the syntactic job is done. But just because a program is structurally correct doesn't mean it makes sense. 

We have to convert syntactic context into a semantic context, validating the semantics of the language as we traverse the AST.

For example, `1 + "hello"` is perfectly valid syntax (parsed as `BinOp.Add(Literal.Int(1), Literal.String("hello"))`), but it is a semantic nonsense.

This is where the rest of the frontend pipeline comes in.

### Renamer

You can declare a variable x in the main scope, and then declare another x inside a while loop. While the parser doesn't care about this and just sees identical strings, the variables are in different scope contexts.

The Renaming stage (often tied to Scope Resolution) walks through the AST and disambiguates these names. It ensures that every variable reference points to the exact declaration it belongs to. By giving every variable a unique ID, we safely resolve shadowing issues.

This pass essentially sanitizes the AST, making life much easier for the Typechecker.

For example:

```
begin
  int x = 10;
  begin
    string x = "a"
  end
end
```

The variable declarations have to be renamed as:
- For the outer scope `x`: `Update(Renamed(x, 0, ...), Literal.Int(10))`
- For the inner scope `x`: `Update(Renamed(x, 1, ...), Literal.String("a"))`

### Typechecker

This is where the semantic rules of WACC are strictly enforced. The typechecker traverses the renamed AST and answers constraints such as:

- Type mismatch
- Function parameter mismatch
- Freeing on a non-freeable type

and so on.

Since we are writing this in Scala, the typechecker is essentially a massive set of recursive match statements over the AST nodes. It computes the expected type of every Expr and ensures every Stmt is valid within its current context, and ensures types "satisfy" their constraints.

The typechecker also has to factor in type weakenings, such as conversion of `char[]` into `string`.

If a program passes this stage without throwing any semantic errors, we finally have a structurally and semantically sound program. The frontend's job is officially complete.

## Backend

todo
