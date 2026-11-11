Run JavaScript against the Space when a plain batch would be long or needs computing: forty nodes from a list, a layout from data, a search before an edit. space.add, space.patch, space.remove and space.arrange take the same fields as the apply ops; space.find(query) reads the scene. Everything the code writes is one batch, with the same ownership rules, repairs and lints as apply. Whatever it returns comes back as result.

The code runs in a sandbox with no network, files or clock. For a handful of ops, apply is simpler.
