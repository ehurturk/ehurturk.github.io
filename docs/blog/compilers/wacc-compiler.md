---
icon: lucide/code-2
---

# Writing a Compiler for WACC in Scala 3

This write-up is about a compiler my group and I wrote during the [WACC](https://blogs.imperial.ac.uk/computing/2024/02/28/second-year-projects-wacc-and-pintos/) group project in my second year of Computing at Imperial.

I found it fascinating how interesting (and challenging) it is to write a compiler even for a simple language like WACC. My initial mental model of compilers was heavily biased towards *parsers*, but writing it in a functional language, [Scala 3](https://scala-lang.org/), helped me get past that and enjoy the rest of the pipeline.

## Structure of a compiler

A compiler typically consists of:

1. A frontend
2. A backend

It's also possible to have a "mid-end" between the two, for example if the compiler supports staged metaprogramming.

The frontend is concerned with the syntax and semantics of the language and validating it. The backend handles code generation and emitting assembly.

It's also possible to compile a language into another *source* language instead of directly generating assembly — this is called a *transpiler*. Haskell, for instance, originally emitted C code instead of assembly, making it a transpiler.

## Frontend

The frontend typically follows this pipeline:

1. Parser
2. Renamer
3. Typechecker

This pipeline can be expanded or shrunk depending on the language's grammar and complexity. Scala 3, for example, has 80+ passes:

??? info "Full Scala 3 compiler phase list (80+ passes)"

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

The last stage, `genBCode`, generates JVM bytecode (Scala is a JVM language), so it can be considered Scala 3's backend.

Scala 3 is a fairly complicated language with an extensive syntax, so it makes sense for it to have this large a frontend — which shows up as somewhat longer compilation times. WACC, on the other hand, is a simple language from the While family, so its frontend only needs the three stages above.

!!! note

    A lexing stage (converting source text into tokens) normally comes before the parser, but since we used [Parsley](https://j-mie6.github.io/parsley/), it handled lexing and parsing together, removing the need for a separate lexing stage.

### Parser

The parser converts source text into syntactic information. The context here is purely syntactic — it's only concerned with turning the language into a tree structure (an AST) that obeys the language's grammar rules.

Grammar rules are often expressed in BNF, such as:

```
<digit> ::= 0 | 1 | 2 | 3 | 4 | 5 | 6 |7 | 8 | 9
<integer> ::= <digit> | <digit><integer>
<floating point> ::= <integer>.<integer>
```

Or more generally:

```
<rule> ::= <token1> | <token2> | ...
```

This set of BNF rules fully describes the source language, and it's the parser's job to consume the source and produce an AST.

We used a parser-combinator library called Parsley, which — combined with how ergonomic Scala is — made representing the language straightforward. Some example parsers:

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

As you can see, it's relatively easy to parse source text (strings) into AST nodes.

### AST

An abstract syntax tree (AST) is a tree data structure used to store language information. It mainly consists of expressions (`Expr`), statements (`Stmt`), and other nodes depending on the language.

In Scala 3, we modeled this using enums and case classes, which makes pattern matching incredibly powerful later on. A simple expression AST might look like:

```scala
object Expr {
  sealed trait Literal[T <: Id] extends Expr[T]
  // ... (literals)
  sealed trait BinOp[T <: Id] extends Expr[T] { val x: Expr[T] ; val y: Expr[T] }
  // ... (binary ops)
  sealed trait UnOp[T <: Id] extends Expr[T] { val x: Expr[T] }
  // ... (more nodes)
}
```

Once the parser produces this tree, the syntactic job is done. But a program being structurally correct doesn't mean it makes sense — we still have to convert syntactic context into a semantic one, validating the semantics of the language as we traverse the AST.

For example, `1 + "hello"` is perfectly valid syntax (parsed as `BinOp.Add(Literal.Int(1), Literal.String("hello"))`), but it's semantic nonsense. That's what the rest of the frontend pipeline is for.

### Renamer

You can declare a variable `x` in the main scope, then declare another `x` inside a while loop. The parser doesn't care — it just sees identical strings — but the two variables live in different scope contexts.

The renaming stage (often tied to scope resolution) walks the AST and disambiguates these names. It ensures every variable reference points to the exact declaration it belongs to, giving each variable a unique ID so shadowing is resolved safely. This pass sanitizes the AST, making life much easier for the typechecker.

For example:

```
begin
  int x = 10;
  begin
    string x = "a"
  end
end
```

gets renamed as:

- Outer scope `x`: `Update(Renamed(x, 0, ...), Literal.Int(10))`
- Inner scope `x`: `Update(Renamed(x, 1, ...), Literal.String("a"))`

### Typechecker

This is where WACC's semantic rules are strictly enforced. The typechecker traverses the renamed AST and checks things like:

- Type mismatches
- Function parameter mismatches
- Freeing a non-freeable type

and so on.

Since this is Scala, the typechecker is essentially a large set of recursive pattern matches over the AST nodes. It computes the expected type of every `Expr`, ensures every `Stmt` is valid in its current context, and checks that types satisfy their constraints. It also has to account for type weakenings, such as converting `char[]` into `string`.

If a program passes this stage without semantic errors, it's structurally and semantically sound, and the frontend's job is complete.

## Backend

!!! note "Work in progress"

    I haven't written up the backend (code generation, register allocation, and assembly emission) yet — I'll add it here once it's done.
