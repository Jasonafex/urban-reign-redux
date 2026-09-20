# Publishing setup

## GitHub access

Install the GitHub integration in Codex, then authorize it while signed in as **Jasonafex**. Verify the displayed GitHub account before approving. Prefer access only to the release repository if the authorization screen offers that choice. If the integration cannot create a repository with that scope, create an empty public `urban-reign-redux` repository in the GitHub website, then grant the integration access to it. Do not paste passwords or access tokens into chat.

The files in this repository are ready for publication. They contain the website, README and an optional upload workflow—not game images, private models, local logs or the entire development project. No release archive has been created.

Enable Pages in Settings → Pages → Deploy from a branch → `main` → `/docs`. The expected address is `https://jasonafex.github.io/urban-reign-redux/`; this address is not live until the repository is created and Pages finishes deploying. [GitHub publishing instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

If CLI authorization is used instead of the integration, sign in locally with GitHub CLI (`gh auth login`) and verify `gh api user --jq .login` returns Jasonafex. For an account-approved fine-grained credential, the relevant repository permissions are Contents write, Pages write and the permissions GitHub requires for creating/configuring the repository; uploading the workflow also requires Workflows write. Store credentials using GitHub's login tools, not this folder. [GitHub permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

## Screenshots and download links

Five image slots are reserved: hero gameplay, roster, gameplay, loader and editor. Place the images in `docs/screens/`, then replace the corresponding `null` values in `docs/screens.js` with paths such as `screens/roster.webp`. Use real game captures for gameplay slots. The page remains functional with placeholders and does not request nonexistent files.

After publishing a GitHub release, replace the release-board preparation text and add its actual download links. Keep pre-release status until the selected package has completed gameplay testing. The intro video is not ready yet.

Upload your own final ZIP to GitHub Releases; keep installers and mods out of the repository history. Use the same ZIP on other hosts so the checksums match. The player ZIP should contain the launcher installer and a sibling `mods` folder made from **launcher/mods**, not the editor's mod folders. Publish the editor separately if desired. Keep asset credits and permissions with the final package.

## Nexus Mods

Create the first listing through Nexus's upload form. If Urban Reign is absent, use **ADD NEW GAME** and its official title, then complete a usable mod upload. Staff approve the game entry; it is not an instant self-created category. [Nexus new-game process](https://help.nexusmods.com/article/104-how-can-i-add-a-new-game-to-nexus-mods).

After the first page and file exist, configure the `nexus-release` GitHub environment with secret `NEXUSMODS_API_KEY` and variable `NEXUSMODS_FILE_ID` from Nexus's advanced file details. Keep the API key in GitHub Secrets. Then run **Upload an existing release to Nexus Mods** from Actions, selecting your published GitHub release, existing ZIP name, SHA256 and version. It verifies the archive before uploading an update. It does not create ZIPs or create the first Nexus listing. This project uses manual download, not Vortex installation. [Official upload action](https://github.com/Nexus-Mods/upload-action).

The workflow is prepared but has not been run; it requires your accounts and initial Nexus file ID. It is manual-only, so publishing a GitHub release does not silently cross-post it.

## TekkenMods

I found no documented self-service option for adding Urban Reign or an official upload API. The public site is focused on Tekken. Ask staff whether they will accept an Urban Reign game entry before selecting a category. Do not mark it as a Tekken 7/8 mod. Their footer links the Modding Zaibatsu community as a contact route; a short request is provided in the upload kit. This request has not been sent. [Site](https://tekkenmods.com/) · [Guidelines](https://tekkenmods.com/guidelines).

Once accepted, reuse the prepared description, screenshots and same ZIP through the site's upload form. Keep the final mod-page URLs in the website release board.
